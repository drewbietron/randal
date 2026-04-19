import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPrimaryDomain } from "@randal/analytics";
import type {
	Annotation,
	AnnotationVerdict,
	Job,
	JobOrigin,
	ReliabilityScore,
	RunnerEvent,
	RunnerEventType,
	SkillDeployment,
	VoiceSessionAccess,
} from "@randal/core";
import {
	applyVoiceSessionAccessToOpenCodeConfig,
	compileOpenCodeConfig,
	createLogger,
	parseVoiceSessionAccess,
	type RandalConfig,
} from "@randal/core";
import { buildProcessEnv, cleanupTempHome } from "@randal/credentials";
import { getAdapter } from "./agents/index.js";
import { compactContext, shouldCompact } from "./compaction.js";
import { readAndClearContext } from "./context.js";
import { syncJobToLoopState } from "./loop-state.js";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./prompt-assembly.js";
import { findCompletionPromise, generateToken, parseOutput, wrapCommand } from "./sentinel.js";
import { type StreamingResult, readStreamLines } from "./streaming.js";
import { detectFatalError } from "./struggle.js";

/**
 * Resolve the effective model based on available API keys.
 * Priority: OpenRouter (keeps configured default) > Anthropic > OpenAI.
 * Only overrides when the config still uses the schema default and the
 * required provider key isn't available.
 */
function resolveModelFromEnv(configDefault: string, env: Record<string, string>): string {
	// OpenRouter can proxy to any model — if the key is present, keep the default
	if (env.OPENROUTER_API_KEY) {
		return configDefault;
	}
	// Direct Anthropic key — keep default if it's already an Anthropic model
	if (env.ANTHROPIC_API_KEY && configDefault.startsWith("anthropic/")) {
		return configDefault;
	}
	// Direct OpenAI key — switch to OpenAI model if current default needs a different provider
	if (env.OPENAI_API_KEY) {
		if (configDefault.startsWith("openai/")) return configDefault;
		return "openai/gpt-5.4";
	}
	// Direct Anthropic key with non-Anthropic default — fall back to Anthropic
	if (env.ANTHROPIC_API_KEY) {
		return "anthropic/claude-sonnet-4";
	}
	return configDefault;
}

function getRepoRoot(): string {
	return resolve(import.meta.dir, "../../..");
}

function buildVoiceScopedOpenCodeHome(options: {
	env: Record<string, string>;
	config: RandalConfig;
	configBasePath?: string;
	job: Job;
	voiceAccess: VoiceSessionAccess;
}): string {
	const sourceHome = options.env.HOME ?? process.env.HOME ?? "";
	const scopedHome = mkdtempSync(join(tmpdir(), "randal-opencode-home-"));
	const targetConfigDir = join(scopedHome, ".config", "opencode");
	mkdirSync(targetConfigDir, { recursive: true });

	const sourceConfigDir = sourceHome ? join(sourceHome, ".config", "opencode") : "";
	if (sourceConfigDir && existsSync(sourceConfigDir)) {
		for (const entry of readdirSync(sourceConfigDir)) {
			if (entry === "opencode.json") continue;
			try {
				symlinkSync(join(sourceConfigDir, entry), join(targetConfigDir, entry));
			} catch {
				// Best effort — the tailored opencode.json is the critical override.
			}
		}
	}

	const compiled = compileOpenCodeConfig(options.config, {
		basePath: options.configBasePath ?? options.job.workdir,
		repoRoot: getRepoRoot(),
		toolsDir: join(getRepoRoot(), "tools"),
	}).config;
	const scopedConfig = applyVoiceSessionAccessToOpenCodeConfig(compiled, options.voiceAccess);
	writeFileSync(
		join(targetConfigDir, "opencode.json"),
		`${JSON.stringify(scopedConfig, null, "\t")}\n`,
	);

	return scopedHome;
}

function applyVoiceSessionPolicy(options: {
	env: Record<string, string>;
	config: RandalConfig;
	configBasePath?: string;
	job: Job;
	agentName: string;
}): string | null {
	const access = requireVoiceSessionAccess(options.job);
	if (!access) return null;

	options.env.RANDAL_VOICE_ACCESS = JSON.stringify(access);
	options.env.RANDAL_SESSION_ACCESS_CLASS = access.accessClass;
	options.env.RANDAL_SESSION_ALLOWED_GRANTS = access.capabilities.grants.join(",");

	if (access.accessClass !== "external") {
		return null;
	}

	if (!access.capabilities.grants.includes("search")) {
		delete options.env.TAVILY_API_KEY;
	}

	if (options.agentName !== "opencode") {
		return null;
	}

	const scopedHome = buildVoiceScopedOpenCodeHome({ ...options, voiceAccess: access });
	options.env.HOME = scopedHome;
	return scopedHome;
}

function requireVoiceSessionAccess(job: Job): VoiceSessionAccess | null {
	if (job.origin?.channel !== "voice") {
		return null;
	}

	return parseVoiceSessionAccess(job.metadata?.RANDAL_VOICE_ACCESS);
}

export type EventHandler = (event: RunnerEvent) => void;

interface StreamEvent {
	type: "progress" | "plan_updated" | "tool_use";
	progress?: string;
	plan?: unknown[];
	toolName?: string;
	toolArgs?: string;
}

type StreamEventCallback = (event: StreamEvent) => void;

export interface RunnerOptions {
	config: RandalConfig;
	configBasePath?: string;
	onEvent?: EventHandler;
	memorySearch?: (query: string) => Promise<string[]>;
	skillSearch?: (query: string) => Promise<SkillDeployment[]>;
	analyticsData?: () => Promise<{
		scores: ReliabilityScore[];
		annotations: Annotation[];
	}>;
	addAnnotation?: (annotation: Omit<Annotation, "id" | "timestamp">) => Promise<void>;
}

export interface JobRequest {
	prompt?: string;
	specFile?: string;
	agent?: string;
	model?: string;
	maxIterations?: number;
	workdir?: string;
	origin?: JobOrigin;
	metadata?: Record<string, string>;
}

function generateJobId(): string {
	return randomBytes(4).toString("hex");
}

function validateWorkdir(workdir: string, config: RandalConfig): void {
	if (!config.runner.allowedWorkdirs) return;

	const resolved = resolve(workdir);
	const allowed = config.runner.allowedWorkdirs.some((dir) => {
		const resolvedDir = resolve(dir);
		return resolved === resolvedDir || resolved.startsWith(`${resolvedDir}/`);
	});

	if (!allowed) {
		throw new Error(
			`Workdir "${resolved}" is not in allowedWorkdirs: [${config.runner.allowedWorkdirs.join(", ")}]`,
		);
	}
}

function createJob(req: JobRequest, config: RandalConfig): Job {
	const id = generateJobId();
	const now = new Date().toISOString();

	const workdir = req.workdir ?? config.runner.workdir;
	validateWorkdir(workdir, config);

	let prompt = req.prompt ?? "";
	let spec: Job["spec"];

	if (req.specFile) {
		const specPath = resolve(req.workdir ?? config.runner.workdir, req.specFile);
		if (existsSync(specPath)) {
			const content = readFileSync(specPath, "utf-8");
			prompt = content;
			spec = { file: req.specFile, content };
		} else {
			throw new Error(`Spec file not found: ${specPath}`);
		}
	}

	return {
		id,
		status: "queued",
		prompt,
		spec,
		agent: req.agent ?? config.runner.defaultAgent,
		model: req.model ?? config.runner.defaultModel,
		maxIterations: req.maxIterations ?? config.runner.defaultMaxIterations,
		workdir: req.workdir ?? config.runner.workdir,
		createdAt: now,
		startedAt: null,
		completedAt: null,
		duration: null,
		iterations: { current: 0, history: [] },
		plan: [],
		progressHistory: [],
		delegations: [],
		cost: {
			totalTokens: { input: 0, output: 0 },
			estimatedCost: 0,
			wallTime: 0,
		},
		updates: [],
		error: null,
		exitCode: null,
		origin: req.origin,
		metadata: req.metadata,
	};
}

/**
 * Read a readable stream to completion, returning all chunks as a single string.
 */
async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(decoder.decode(value, { stream: true }));
		}
	} catch (err) {
		// Stream ended or errored
		const logger = createLogger({ context: { component: "runner" } });
		logger.debug("Stream read ended", {
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		reader.releaseLock();
	}
	return chunks.join("");
}

/**
 * Build a line handler that detects <progress> and <plan-update> tags
 * in the agent's streaming output and emits events in real-time.
 */
function buildStreamLineHandler(callback: StreamEventCallback): (line: string) => void {
	let tagBuffer: { tag: string; lines: string[] } | null = null;

	function flushTag(tag: string, lines: string[]): void {
		const fullText = lines.join("\n");
		const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
		const match = fullText.match(regex);
		if (!match) return;
		const content = match[1].trim();
		if (!content) return;

		if (tag === "progress") {
			callback({ type: "progress", progress: content });
		} else if (tag === "plan-update") {
			try {
				const parsed = JSON.parse(content);
				if (
					Array.isArray(parsed) &&
					parsed.every(
						(t: unknown) =>
							typeof t === "object" &&
							t !== null &&
							"task" in t &&
							"status" in t &&
							typeof (t as { task: unknown }).task === "string" &&
							typeof (t as { status: unknown }).status === "string",
					)
				) {
					callback({ type: "plan_updated", plan: parsed });
				}
			} catch {
				/* invalid JSON, skip */
			}
		}
	}

	return (line: string) => {
		if (tagBuffer) {
			tagBuffer.lines.push(line);
			if (line.includes(`</${tagBuffer.tag}>`)) {
				flushTag(tagBuffer.tag, tagBuffer.lines);
				tagBuffer = null;
			}
			return;
		}

		const openMatch = line.match(/<(progress|plan-update)>/);
		if (openMatch) {
			tagBuffer = { tag: openMatch[1], lines: [line] };
			if (line.includes(`</${openMatch[1]}>`)) {
				flushTag(tagBuffer.tag, tagBuffer.lines);
				tagBuffer = null;
			}
		}
	};
}

export class Runner {
	private config: RandalConfig;
	private configBasePath: string;
	private onEvent: EventHandler;
	private memorySearch?: (query: string) => Promise<string[]>;
	private skillSearch?: (query: string) => Promise<SkillDeployment[]>;
	private analyticsData?: () => Promise<{
		scores: ReliabilityScore[];
		annotations: Annotation[];
	}>;
	private addAnnotation?: (annotation: Omit<Annotation, "id" | "timestamp">) => Promise<void>;
	private activeJobs: Map<
		string,
		{ job: Job; aborted: boolean; proc?: ReturnType<typeof Bun.spawn> }
	> = new Map();
	private logger = createLogger({ context: { component: "runner" } });

	constructor(options: RunnerOptions) {
		this.config = options.config;
		this.configBasePath = options.configBasePath ?? ".";
		this.onEvent = options.onEvent ?? (() => {});
		this.memorySearch = options.memorySearch;
		this.skillSearch = options.skillSearch;
		this.analyticsData = options.analyticsData;
		this.addAnnotation = options.addAnnotation;
	}

	private async autoAnnotate(job: Job): Promise<void> {
		if (!this.config.analytics.autoAnnotationPrompt) return;
		if (!this.addAnnotation) return;

		try {
			const verdict: AnnotationVerdict =
				job.status === "complete" ? "pass" : job.status === "failed" ? "fail" : "partial";

			const totalFiles = new Set(job.iterations.history.flatMap((iter) => iter.filesChanged));

			await this.addAnnotation({
				jobId: job.id,
				verdict,
				agent: job.agent,
				model: job.model,
				domain: getPrimaryDomain(job.prompt, this.config.analytics.domainKeywords),
				iterationCount: job.iterations.current,
				tokenCost: job.cost.totalTokens.input + job.cost.totalTokens.output,
				duration: job.duration ?? 0,
				filesChanged: [...totalFiles],
				prompt: job.prompt.slice(0, 500), // Truncate for storage
				feedback: job.error ?? undefined,
			});

			this.logger.info("Auto-annotation created", {
				jobId: job.id,
				verdict,
			});
		} catch (err) {
			this.logger.warn("Failed to auto-annotate job", {
				jobId: job.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private emit(type: RunnerEventType, job: Job, data: RunnerEvent["data"] = {}): void {
		const event: RunnerEvent = {
			type,
			jobId: job.id,
			timestamp: new Date().toISOString(),
			data,
		};
		this.onEvent(event);
	}

	/**
	 * Submit and execute a job through the ralph loop.
	 * Blocks until the job completes.
	 */
	async execute(request: JobRequest): Promise<Job> {
		const job = createJob(request, this.config);
		this.activeJobs.set(job.id, { job, aborted: false });

		this.emit("job.queued", job);

		try {
			return await this.runLoop(job);
		} finally {
			this.activeJobs.delete(job.id);
		}
	}

	/**
	 * Submit a job and return the job ID immediately.
	 * The job runs in the background; use `done` to await completion.
	 * This eliminates the race condition of needing a job ID before execute() resolves.
	 */
	submit(request: JobRequest): { jobId: string; done: Promise<Job> } {
		const job = createJob(request, this.config);
		this.activeJobs.set(job.id, { job, aborted: false });

		this.emit("job.queued", job);

		const done = this.runLoop(job).finally(() => {
			this.activeJobs.delete(job.id);
		});

		return { jobId: job.id, done };
	}

	/**
	 * Resume an existing job that was interrupted (e.g. by a gateway restart).
	 * Picks up from the last completed iteration and continues the loop.
	 */
	resume(job: Job): { jobId: string; done: Promise<Job> } {
		// Reset status back to running — it was saved as "running" when interrupted
		job.status = "running";
		this.activeJobs.set(job.id, { job, aborted: false });

		this.logger.info("Resuming interrupted job", {
			jobId: job.id,
			completedIterations: job.iterations.current,
			maxIterations: job.maxIterations,
		});

		this.emit("job.resumed", job, {
			iteration: job.iterations.current,
			maxIterations: job.maxIterations,
		});

		const done = this.runLoop(job).finally(() => {
			this.activeJobs.delete(job.id);
		});

		return { jobId: job.id, done };
	}

	/**
	 * Stop a running job. Kills the child process if one is active.
	 */
	stop(jobId: string): boolean {
		const entry = this.activeJobs.get(jobId);
		if (!entry) return false;
		entry.aborted = true;
		entry.job.status = "stopped";
		if (entry.proc) {
			entry.proc.kill("SIGTERM");
			// Force kill after 5 seconds if still running
			const proc = entry.proc;
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// Process already exited
				}
			}, 5000);
		}
		this.emit("job.stopped", entry.job);
		return true;
	}

	/**
	 * Get the current state of an active job.
	 */
	getJob(jobId: string): Job | undefined {
		return this.activeJobs.get(jobId)?.job;
	}

	/**
	 * Get all active jobs.
	 */
	getActiveJobs(): Job[] {
		return [...this.activeJobs.values()].map((e) => e.job);
	}

	/**
	 * Brain-managed session: spawn a single long-lived OpenCode session.
	 * The brain (randal.md + skills) manages the full plan→build lifecycle
	 * internally. The Runner just watches stdout for structured tags,
	 * manages the job envelope, and emits events.
	 */
	private async runBrainSession(job: Job): Promise<Job> {
		job.status = "running";
		job.startedAt = new Date().toISOString();
		const loopStart = Date.now();
		syncJobToLoopState(job);

		this.emit("job.started", job);

		const adapter = getAdapter(job.agent);
		const { env, tempHome, auditLog } = await buildProcessEnv(this.config, this.configBasePath);
		const tempHomes = tempHome ? [tempHome] : [];

		// Log credential resolution diagnostics
		const apiKeyVars = Object.keys(env).filter(
			(k) => k.includes("API_KEY") || k.includes("TOKEN") || k.includes("SECRET"),
		);
		this.logger.info("Credentials resolved for brain session", {
			jobId: job.id,
			envVarCount: Object.keys(env).length,
			apiKeysPresent: apiKeyVars.map((k) => `${k}=${env[k] ? "set" : "missing"}`),
			hasOpenRouterKey: !!env.OPENROUTER_API_KEY,
			hasAnthropicKey: !!env.ANTHROPIC_API_KEY,
			hasOpenAiKey: !!env.OPENAI_API_KEY,
			tempHome: tempHome ?? "(none)",
			inheritConfig: this.config.credentials.inherit,
		});

		// Resolve model based on available API keys (auto-detect provider)
		const effectiveModel = resolveModelFromEnv(job.model, env);
		if (effectiveModel !== job.model) {
			this.logger.info("Auto-resolved model based on available API keys", {
				jobId: job.id,
				originalModel: job.model,
				resolvedModel: effectiveModel,
			});
			job.model = effectiveModel;
		}

		// Inject origin metadata so the brain knows its channel context
		if (job.origin?.channel) env.RANDAL_CHANNEL = job.origin.channel;
		if (job.origin?.from) env.RANDAL_FROM = job.origin.from;
		if (job.origin?.replyTo) env.RANDAL_REPLY_TO = job.origin.replyTo;
		env.RANDAL_TRIGGER = job.origin?.triggerType ?? "user";

		// Inject scheduler-specific env vars (cron name from replyTo)
		if (job.origin?.replyTo?.startsWith("cron:")) {
			env.RANDAL_CRON_NAME = job.origin.replyTo.replace("cron:", "");
		}

		// Spread job metadata into env vars (e.g. RANDAL_HEARTBEAT_TICK)
		if (job.metadata) {
			for (const [key, value] of Object.entries(job.metadata)) {
				env[key] = value;
			}
		}

		if (job.origin?.channel === "voice" && !requireVoiceSessionAccess(job)) {
			job.status = "failed";
			job.error = "Voice session access metadata is missing or invalid";
			job.exitCode = null;
			job.completedAt = new Date().toISOString();
			job.duration = 0;
			syncJobToLoopState(job);
			this.emit("job.failed", job, { error: job.error });
			await this.autoAnnotate(job);
			return job;
		}

		const voiceScopedHome = applyVoiceSessionPolicy({
			env,
			config: this.config,
			configBasePath: this.configBasePath,
			job,
			agentName: job.agent,
		});
		if (voiceScopedHome) {
			tempHomes.push(voiceScopedHome);
		}

		// Derive gateway URL for MCP tool callbacks (channel_send, channel_list)
		const httpCh = this.config.gateway?.channels?.find((c) => c.type === "http");
		if (httpCh?.type === "http") {
			env.RANDAL_GATEWAY_URL = `http://localhost:${httpCh.port}`;
			if (httpCh.auth) env.RANDAL_GATEWAY_AUTH = httpCh.auth;
		}

		// Log service audit entries
		if (auditLog.length > 0) {
			this.logger.info("Service credentials resolved", {
				services: auditLog.map((e) => `${e.service} (${e.type})`),
			});
		}

		try {
			const entry = this.activeJobs.get(job.id);
			if (!entry || entry.aborted) {
				job.status = "stopped";
				syncJobToLoopState(job);
				return job;
			}

			// Check for injected context (channel input written before job start)
			const injectedContext = readAndClearContext(job.workdir);
			if (injectedContext) {
				this.emit("job.context_injected", job, { contextText: injectedContext });
			}

			// Context compaction for resumed jobs with iteration history
			let compactedContextText: string | undefined;
			const compactionCfg = this.config.runner.compaction;
			if (compactionCfg.enabled && job.iterations.history.length > 2) {
				// Estimate current context size from iteration history
				const estimatedTokens = job.iterations.history.reduce(
					(sum, iter) => sum + iter.tokens.input + iter.tokens.output,
					0,
				);
				// Use a reasonable default for maxContextWindow based on model
				const maxContextWindow = 128000; // TODO: derive from model config
				if (shouldCompact(estimatedTokens, compactionCfg.threshold, maxContextWindow)) {
					const result = compactContext({
						iterations: job.iterations.history,
						plan: job.plan,
						delegations: job.delegations,
						injectedContext: injectedContext ? [injectedContext] : undefined,
						compactionConfig: compactionCfg,
					});
					compactedContextText = result.compactedContext;
					this.emit("job.compacted", job, {
						iterationsCompacted: result.iterationsCompacted,
						originalTokens: result.originalTokens,
						compactedTokens: result.compactedTokens,
					});
				}
			}

			// Build minimal prompt — brain has its own persona/rules/knowledge.
			// Only channel context and analytics feedback are injected (if applicable).
			let feedbackInjection: BuildSystemPromptOptions["feedbackInjection"];
			if (this.config.analytics.feedbackInjection && this.analyticsData) {
				try {
					const { scores, annotations } = await this.analyticsData();
					const domain = getPrimaryDomain(job.prompt, this.config.analytics.domainKeywords);
					feedbackInjection = { enabled: true, scores, annotations, taskDomain: domain };
				} catch (err) {
					this.logger.warn("Failed to load analytics for feedback injection", {
						error: String(err),
					});
				}
			}

			const systemPrompt = await buildSystemPrompt(this.config, this.configBasePath, {
				injectedContext: injectedContext ?? undefined,
				feedbackInjection,
			});

			const prompt = compactedContextText
				? `${systemPrompt}\n\n## Resumed Context (Compacted)\n${compactedContextText}\n\n---\n\n${job.prompt}`
				: systemPrompt
					? `${systemPrompt}\n\n---\n\n${job.prompt}`
					: job.prompt;

			const args = adapter.buildCommand({
				prompt,
				model: job.model,
				systemPrompt: undefined,
				workdir: job.workdir,
				agentName: (this.config.runner as Record<string, unknown>).agentName as string | undefined,
			});

			// Add adapter-specific env overrides
			const adapterEnv = adapter.envOverrides?.({
				prompt,
				model: job.model,
				workdir: job.workdir,
			});

			const finalEnv = {
				...env,
				...adapterEnv,
				RANDAL_JOB_ID: job.id,
				RANDAL_BRAIN_SESSION: "true",
			};

			const token = generateToken();
			const { shell } = wrapCommand(token, adapter.binary, args);

			this.logger.info("Spawning brain process", {
				jobId: job.id,
				agent: job.agent,
				model: job.model,
				binary: adapter.binary,
				shell: shell.slice(0, 200),
				cwd: job.workdir,
				envKeys: Object.keys(finalEnv).sort().join(", "),
			});

			const proc = Bun.spawn(["bash", "-c", shell], {
				cwd: job.workdir,
				env: finalEnv,
				stdout: "pipe",
				stderr: "pipe",
			});

			// Store proc reference for stop/cancel
			if (entry) {
				entry.proc = proc;
			}

			// Build streaming callback for real-time tag detection
			const onStreamEvent: StreamEventCallback = (streamEvt) => {
				if (streamEvt.type === "progress" && streamEvt.progress) {
					this.emit("iteration.output", job, {
						iteration: 1,
						outputLine: streamEvt.progress,
					});
				} else if (streamEvt.type === "plan_updated" && streamEvt.plan) {
					this.emit("job.plan_updated", job, {
						plan: streamEvt.plan as RunnerEvent["data"]["plan"],
						iteration: 1,
					});
				} else if (streamEvt.type === "tool_use") {
					this.emit("iteration.tool_use", job, {
						toolName: streamEvt.toolName,
						toolArgs: streamEvt.toolArgs,
						iteration: 1,
					});
				}
			};

			// Start reading stdout (streaming with real-time event detection) and stderr (batch)
			const stdoutPromise = readStreamLines(proc.stdout, {
				onLine: buildStreamLineHandler(onStreamEvent),
				onToolUse: (event) =>
					onStreamEvent({ type: "tool_use", toolName: event.tool, toolArgs: event.args }),
				parseToolUse: adapter.parseToolUse,
				maxEventsPerSecond: 0,
			});
			const stderrPromise = readStream(proc.stderr);

			// Wait for process exit with session timeout
			const sessionTimeoutSecs =
				((this.config.runner as Record<string, unknown>).sessionTimeout as number) ?? 3600;
			const timeoutMs = sessionTimeoutSecs * 1000;
			let timedOut = false;

			const exitCode = await Promise.race([
				proc.exited,
				new Promise<number>((resolve) =>
					setTimeout(() => {
						timedOut = true;
						try {
							proc.kill("SIGKILL");
						} catch {
							// Process already exited
						}
						resolve(124);
					}, timeoutMs),
				),
			]);

			if (timedOut) {
				this.logger.warn("Brain session timed out", {
					jobId: job.id,
					timeoutSecs: sessionTimeoutSecs,
				});
			}

			// Collect output with a short timeout for stream cleanup
			const [stdoutResult, stderr] = await Promise.race([
				Promise.all([stdoutPromise, stderrPromise]),
				new Promise<[StreamingResult, string]>((resolve) =>
					setTimeout(() => resolve([{ output: "", toolUses: [], lineCount: 0 }, ""]), 1000),
				),
			]);
			const stdout = stdoutResult.output;

			const duration = Math.round((Date.now() - loopStart) / 1000);

			// Parse sentinel markers for clean agent output
			const parsed = parseOutput(stdout, token);
			const agentOutput = parsed?.output ?? stdout;
			const sentinelExitCode = parsed?.exitCode ?? exitCode;

			this.logger.info("Brain process exited", {
				jobId: job.id,
				exitCode,
				sentinelExitCode,
				duration,
				stdoutLength: stdout.length,
				stderrLength: stderr.length,
				agentOutputLength: agentOutput.length,
				agentOutputPreview: agentOutput.slice(0, 500) || "(empty)",
				stderrPreview: stderr.slice(0, 1000) || "(empty)",
				sentinelParsed: !!parsed,
				timedOut,
			});

			// Parse token usage
			const tokens = adapter.parseUsage?.(agentOutput) ?? { input: 0, output: 0 };
			job.cost.totalTokens.input += tokens.input;
			job.cost.totalTokens.output += tokens.output;
			job.cost.wallTime = duration;

			// Clear proc reference
			if (entry) {
				entry.proc = undefined;
			}

			// Check if job was stopped during execution
			if (entry.aborted) {
				job.status = "stopped";
				job.completedAt = new Date().toISOString();
				job.duration = duration;
				syncJobToLoopState(job);
				return job;
			}

			// Check for fatal errors
			const fatalCheck = detectFatalError(agentOutput, stderr);
			if (fatalCheck.isFatal) {
				job.status = "failed";
				job.error = `Fatal: ${fatalCheck.error}`;
				job.exitCode = sentinelExitCode;
				job.completedAt = new Date().toISOString();
				job.duration = duration;
				syncJobToLoopState(job);
				this.emit("job.failed", job, { error: job.error });
				await this.autoAnnotate(job);
				return job;
			}

			// Check for completion promise
			const promiseFound = findCompletionPromise(agentOutput, this.config.runner.completionPromise);

			if (promiseFound) {
				job.status = "complete";
				job.exitCode = sentinelExitCode;
				job.completedAt = new Date().toISOString();
				job.duration = duration;
				syncJobToLoopState(job);
				this.emit("job.complete", job, { duration, output: agentOutput });
				await this.autoAnnotate(job);
				return job;
			}

			// Edge case: empty output with exit code 0 = failure (likely TUI mode or binary not found)
			if (!agentOutput.trim() && sentinelExitCode === 0) {
				this.logger.error("Brain produced no output — diagnosing", {
					jobId: job.id,
					rawExitCode: exitCode,
					sentinelExitCode,
					rawStdoutLength: stdout.length,
					rawStdout: stdout.slice(0, 1000) || "(completely empty)",
					rawStderrFull: stderr || "(completely empty)",
					sentinelParsed: !!parsed,
					parsedOutput: parsed?.output?.slice(0, 500) ?? "(null)",
					parsedExitCode: parsed?.exitCode ?? "(null)",
					duration,
				});
				job.status = "failed";
				job.error = "Brain session produced no output (possible misconfiguration)";
				job.exitCode = sentinelExitCode;
				job.completedAt = new Date().toISOString();
				job.duration = duration;
				syncJobToLoopState(job);
				this.emit("job.failed", job, { error: job.error });
				await this.autoAnnotate(job);
				return job;
			}

			// Clean exit (code 0) without promise = brain decided it was done
			if (sentinelExitCode === 0) {
				job.status = "complete";
				job.exitCode = 0;
				job.completedAt = new Date().toISOString();
				job.duration = duration;
				syncJobToLoopState(job);
				this.emit("job.complete", job, { duration, output: agentOutput });
				await this.autoAnnotate(job);
				return job;
			}

			// Non-zero exit without promise = failure
			job.status = "failed";
			job.error = timedOut
				? `Brain session timed out after ${sessionTimeoutSecs}s`
				: `Brain session exited with code ${sentinelExitCode}`;
			job.exitCode = sentinelExitCode;
			job.completedAt = new Date().toISOString();
			job.duration = duration;
			syncJobToLoopState(job);
			this.emit("job.failed", job, { error: job.error });
			await this.autoAnnotate(job);
			return job;
		} finally {
			for (const home of tempHomes) {
				cleanupTempHome(home);
			}
		}
	}

	private async runLoop(job: Job): Promise<Job> {
		return this.runBrainSession(job);
	}
}
