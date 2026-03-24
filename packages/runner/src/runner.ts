import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
	DelegationRequest,
	DelegationResult,
	Job,
	JobIteration,
	JobOrigin,
	RunnerEvent,
	RunnerEventType,
	SkillCleanup,
	SkillDeployment,
} from "@randal/core";
import { type RandalConfig, createLogger } from "@randal/core";
import { buildProcessEnv, cleanupTempHome } from "@randal/credentials";
import { type AgentAdapter, getAdapter } from "./agents/index.js";
import { readAndClearContext } from "./context.js";
import { parseDelegationRequests, parsePlanUpdate, parseProgress } from "./plan-parser.js";
import { buildSystemPrompt } from "./prompt-assembly.js";
import { findCompletionPromise, generateToken, parseOutput, wrapCommand } from "./sentinel.js";
import { type StreamingResult, readStreamLines } from "./streaming.js";
import { type StruggleConfig, detectFatalError, detectStruggle } from "./struggle.js";

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
	/** Internal: current delegation depth (used by child runners). */
	delegationDepth?: number;
}

export interface JobRequest {
	prompt?: string;
	specFile?: string;
	agent?: string;
	model?: string;
	maxIterations?: number;
	workdir?: string;
	origin?: JobOrigin;
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

/**
 * Execute a single iteration of the ralph loop.
 * Spawns the agent process, captures output, and parses results.
 */
async function executeIteration(
	job: Job,
	adapter: AgentAdapter,
	env: Record<string, string>,
	systemPrompt: string,
	iterationTimeoutSecs: number,
	completionPromiseTag: string,
	activeJobEntry?: { job: Job; aborted: boolean; proc?: ReturnType<typeof Bun.spawn> },
	onStreamEvent?: StreamEventCallback,
): Promise<JobIteration> {
	const iterStart = Date.now();
	const iterNum = job.iterations.current + 1;

	const prompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${job.prompt}` : job.prompt;

	const args = adapter.buildCommand({
		prompt,
		model: job.model,
		systemPrompt: undefined, // already merged into prompt
		workdir: job.workdir,
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
		RANDAL_ITERATION: String(iterNum),
	};

	const token = generateToken();
	const { shell } = wrapCommand(token, adapter.binary, args);

	const proc = Bun.spawn(["bash", "-c", shell], {
		cwd: job.workdir,
		env: finalEnv,
		stdout: "pipe",
		stderr: "pipe",
	});

	// Store proc reference for kill-on-stop
	if (activeJobEntry) {
		activeJobEntry.proc = proc;
	}

	// Start reading stdout (streaming with real-time event detection) and stderr (batch)
	const stdoutPromise = readStreamLines(proc.stdout, {
		onLine: onStreamEvent ? buildStreamLineHandler(onStreamEvent) : undefined,
		onToolUse: onStreamEvent
			? (event) => onStreamEvent({ type: "tool_use", toolName: event.tool, toolArgs: event.args })
			: undefined,
		parseToolUse: adapter.parseToolUse,
		maxEventsPerSecond: 0, // No rate limiting — tag detection needs every line
	});
	const stderrPromise = readStream(proc.stderr);

	// Wait for process exit with iteration timeout
	const timeoutMs = iterationTimeoutSecs * 1000;
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
				resolve(124); // Standard timeout exit code
			}, timeoutMs),
		),
	]);

	if (timedOut) {
		const logger = createLogger({ context: { component: "runner" } });
		logger.warn("Iteration timed out", {
			jobId: job.id,
			iteration: iterNum,
			timeoutSecs: iterationTimeoutSecs,
		});
	}

	// Collect whatever output we have, with a short timeout for stream cleanup
	const [stdoutResult, stderr] = await Promise.race([
		Promise.all([stdoutPromise, stderrPromise]),
		new Promise<[StreamingResult, string]>((resolve) =>
			setTimeout(() => resolve([{ output: "", toolUses: [], lineCount: 0 }, ""]), 1000),
		),
	]);
	const stdout = stdoutResult.output;

	const duration = Math.round((Date.now() - iterStart) / 1000);

	// Parse sentinel markers to extract clean agent output
	const parsed = parseOutput(stdout, token);
	const agentOutput = parsed?.output ?? stdout; // Fallback to raw if markers not found
	const sentinelExitCode = parsed?.exitCode ?? exitCode;

	// Parse token usage if adapter supports it
	const tokens = adapter.parseUsage?.(agentOutput) ?? { input: 0, output: 0 };

	// Detect file changes via git diff (simple heuristic)
	const filesChanged = parseFilesChanged(agentOutput);

	// Extract summary (first meaningful line)
	const summary = extractSummary(agentOutput);

	// Log stderr at warn level when non-empty
	if (stderr.trim()) {
		const logger = createLogger({ context: { component: "runner" } });
		logger.warn("Agent stderr output", {
			jobId: job.id,
			iteration: iterNum,
			stderr: stderr.slice(0, 1000),
		});
	}

	// Clear proc reference after completion
	if (activeJobEntry) {
		activeJobEntry.proc = undefined;
	}

	// Check for completion promise using the clean agent output
	const promiseFound = findCompletionPromise(agentOutput, completionPromiseTag);

	// Check for fatal errors in agent output (auth failures, etc.)
	const fatalCheck = detectFatalError(agentOutput, stderr);

	// Parse structured output tags (non-fatal — null/empty on failure)
	const planUpdate = parsePlanUpdate(agentOutput);
	const progress = parseProgress(agentOutput);
	const delegationReqs = parseDelegationRequests(agentOutput);

	return {
		number: iterNum,
		startedAt: new Date(iterStart).toISOString(),
		duration,
		filesChanged,
		tokens,
		exitCode: sentinelExitCode,
		promiseFound,
		summary,
		output: agentOutput || undefined,
		stderr: stderr.trim() || undefined,
		fatalError: fatalCheck.isFatal ? fatalCheck.error : undefined,
		planUpdate: planUpdate ?? undefined,
		progress: progress ?? undefined,
		delegationRequests: delegationReqs.length > 0 ? delegationReqs : undefined,
	};
}

function parseFilesChanged(output: string): string[] {
	// Look for common patterns indicating file changes
	const files: Set<string> = new Set();

	// Match "Created file.ts" or "Modified file.ts" patterns
	for (const match of output.matchAll(
		/(?:created|modified|wrote|updated|edited)\s+([^\s,]+\.\w+)/gi,
	)) {
		files.add(match[1]);
	}

	// Match "// iteration N" >> "file.ts" pattern from mock agent
	for (const match of output.matchAll(/>> "?([^\s"]+\.\w+)"?/g)) {
		files.add(match[1]);
	}

	return [...files];
}

function extractSummary(output: string): string {
	const lines = output.split("\n").filter((l) => {
		const t = l.trim();
		return t && !t.startsWith("__START_") && !t.startsWith("__DONE_");
	});
	return lines[0]?.trim().slice(0, 200) ?? "";
}

export class Runner {
	private config: RandalConfig;
	private configBasePath: string;
	private onEvent: EventHandler;
	private memorySearch?: (query: string) => Promise<string[]>;
	private skillSearch?: (query: string) => Promise<SkillDeployment[]>;
	private activeJobs: Map<
		string,
		{ job: Job; aborted: boolean; proc?: ReturnType<typeof Bun.spawn> }
	> = new Map();
	private logger = createLogger({ context: { component: "runner" } });
	private delegationDepth: number;
	private maxDelegationDepth: number;
	private maxDelegationsPerIteration: number;

	constructor(options: RunnerOptions) {
		this.config = options.config;
		this.configBasePath = options.configBasePath ?? ".";
		this.onEvent = options.onEvent ?? (() => {});
		this.memorySearch = options.memorySearch;
		this.skillSearch = options.skillSearch;
		this.delegationDepth = options.delegationDepth ?? 0;
		this.maxDelegationDepth = this.config.runner.maxDelegationDepth ?? 2;
		this.maxDelegationsPerIteration = this.config.runner.maxDelegationsPerIteration ?? 3;
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
	 * Execute a delegation request as a child job.
	 */
	private async executeDelegation(
		parentJob: Job,
		request: DelegationRequest,
		_iterationNumber: number,
	): Promise<void> {
		this.emit("job.delegation.started", parentJob, {
			delegationTask: request.task,
		});

		const childPrompt = request.context
			? `## Delegated Task\n${request.task}\n\n## Context\n${request.context}`
			: `## Delegated Task\n${request.task}`;

		const childRunner = new Runner({
			config: this.config,
			configBasePath: this.configBasePath,
			onEvent: this.onEvent,
			memorySearch: this.memorySearch,
			skillSearch: this.skillSearch,
			delegationDepth: this.delegationDepth + 1,
		});

		const startTime = Date.now();
		try {
			const childJob = await childRunner.execute({
				prompt: childPrompt,
				workdir: parentJob.workdir,
				agent: request.agent ?? parentJob.agent,
				model: request.model ?? parentJob.model,
				maxIterations: request.maxIterations ?? 5,
			});

			// Set parentJobId on child (it's already completed at this point)
			childJob.parentJobId = parentJob.id;

			const result: DelegationResult = {
				jobId: childJob.id,
				task: request.task,
				status: childJob.status,
				summary:
					childJob.iterations.history.length > 0
						? childJob.iterations.history[childJob.iterations.history.length - 1].summary
						: "",
				filesChanged: childJob.iterations.history.flatMap((h) => h.filesChanged),
				duration: Math.round((Date.now() - startTime) / 1000),
			};

			if (childJob.error) {
				result.error = childJob.error;
			}

			parentJob.delegations.push(result);

			this.emit("job.delegation.completed", parentJob, {
				delegationTask: request.task,
				delegationJobId: childJob.id,
				delegationStatus: childJob.status,
			});
		} catch (err) {
			const result: DelegationResult = {
				jobId: "error",
				task: request.task,
				status: "failed",
				summary: "",
				filesChanged: [],
				duration: Math.round((Date.now() - startTime) / 1000),
				error: err instanceof Error ? err.message : String(err),
			};

			parentJob.delegations.push(result);

			this.logger.warn("Delegation execution failed", {
				task: request.task,
				error: err instanceof Error ? err.message : String(err),
			});

			this.emit("job.delegation.completed", parentJob, {
				delegationTask: request.task,
				delegationStatus: "failed",
			});
		}
	}

	private async runLoop(job: Job): Promise<Job> {
		job.status = "running";
		job.startedAt = new Date().toISOString();
		const loopStart = Date.now();

		this.emit("job.started", job);

		const adapter = getAdapter(job.agent);
		const { env, tempHome, auditLog } = await buildProcessEnv(this.config, this.configBasePath);

		// Log service audit entries
		if (auditLog.length > 0) {
			this.logger.info("Service credentials resolved", {
				services: auditLog.map((e) => `${e.service} (${e.type})`),
			});
		}

		const struggleConfig: StruggleConfig = {
			noChangeThreshold: this.config.runner.struggle.noChangeThreshold,
			maxRepeatedErrors: this.config.runner.struggle.maxRepeatedErrors,
		};

		// Deploy skills if available
		let skillCleanup: SkillCleanup | undefined;
		let skillContext: string[] = [];

		if (this.skillSearch) {
			try {
				const selectedSkills = await this.skillSearch(job.prompt);
				if (selectedSkills.length > 0 && adapter.deploySkills) {
					// Native path: deploy to agent's skill directory
					skillCleanup = await adapter.deploySkills(selectedSkills, job.workdir);
					this.logger.info("Skills deployed natively", {
						agent: job.agent,
						skills: selectedSkills.map((s) => s.name),
					});
				} else if (selectedSkills.length > 0) {
					// Fallback: inject into prompt
					skillContext = selectedSkills.map((s) => `--- Skill: ${s.name} ---\n${s.content}`);
					this.logger.info("Skills injected via prompt", {
						agent: job.agent,
						skills: selectedSkills.map((s) => s.name),
					});
				}
			} catch (err) {
				this.logger.warn("Skill search/deployment failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		let stuckWarned = false;
		try {
			for (let i = 0; i < job.maxIterations; i++) {
				const entry = this.activeJobs.get(job.id);
				if (!entry || entry.aborted) break;

				// Check for injected context
				const injectedContext = readAndClearContext(job.workdir);
				if (injectedContext) {
					this.emit("job.context_injected", job, {
						contextText: injectedContext,
					});
				}

				// Query memory for relevant context
				let memoryContext: string[] = [];
				if (this.memorySearch && this.config.memory.autoInject.enabled) {
					try {
						memoryContext = await this.memorySearch(job.prompt);
					} catch (err) {
						this.logger.warn("Memory search failed, continuing without memory context", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}

				// Build system prompt
				const includeProtocol = adapter.supportsProtocol !== false;
				const systemPrompt = await buildSystemPrompt(this.config, this.configBasePath, {
					memoryContext,
					injectedContext: injectedContext ?? undefined,
					skillContext,
					currentPlan: job.plan.length > 0 ? job.plan : undefined,
					progressHistory: job.progressHistory.length > 0 ? job.progressHistory : undefined,
					delegationResults: job.delegations.length > 0 ? job.delegations : undefined,
					includeProtocol,
				});

				this.emit("iteration.start", job, {
					iteration: i + 1,
					maxIterations: job.maxIterations,
				});

				// Build streaming callback for real-time progress events
				const iterNum = i + 1;
				const onStreamEvent: StreamEventCallback = (streamEvt) => {
					if (streamEvt.type === "progress" && streamEvt.progress) {
						this.emit("iteration.output", job, {
							iteration: iterNum,
							maxIterations: job.maxIterations,
							outputLine: streamEvt.progress,
						});
					} else if (streamEvt.type === "plan_updated" && streamEvt.plan) {
						this.emit("job.plan_updated", job, {
							plan: streamEvt.plan as RunnerEvent["data"]["plan"],
							iteration: iterNum,
						});
					} else if (streamEvt.type === "tool_use") {
						this.emit("iteration.tool_use", job, {
							toolName: streamEvt.toolName,
							toolArgs: streamEvt.toolArgs,
							iteration: iterNum,
						});
					}
				};

				// Execute iteration
				const iteration = await executeIteration(
					job,
					adapter,
					env,
					systemPrompt,
					this.config.runner.iterationTimeout,
					this.config.runner.completionPromise,
					entry,
					onStreamEvent,
				);

				// Update job state
				job.iterations.current = iteration.number;
				job.iterations.history.push(iteration);
				job.cost.totalTokens.input += iteration.tokens.input;
				job.cost.totalTokens.output += iteration.tokens.output;
				job.cost.wallTime = Math.round((Date.now() - loopStart) / 1000);
				job.updates.push(`Iteration ${iteration.number}: ${iteration.summary || "completed"}`);

				this.emit("iteration.end", job, {
					iteration: iteration.number,
					maxIterations: job.maxIterations,
					filesChanged: iteration.filesChanged,
					tokensUsed: iteration.tokens,
					duration: iteration.duration,
					summary: iteration.summary,
					exitCode: iteration.exitCode,
				});

				// Update plan if iteration produced a plan-update
				if (iteration.planUpdate) {
					const now = new Date().toISOString();
					job.plan = iteration.planUpdate.map((t) => ({
						...t,
						updatedAt: now,
						iterationNumber: iteration.number,
					}));
					this.emit("job.plan_updated", job, {
						plan: job.plan,
					});
				}

				// Update progress history (sliding window, max 3)
				if (iteration.progress) {
					job.progressHistory.push(iteration.progress);
					if (job.progressHistory.length > 3) {
						job.progressHistory = job.progressHistory.slice(-3);
					}
				}

				// Handle delegation requests
				if (
					iteration.delegationRequests &&
					iteration.delegationRequests.length > 0 &&
					this.delegationDepth < this.maxDelegationDepth
				) {
					const maxDelegations = this.maxDelegationsPerIteration;
					const requests = iteration.delegationRequests.slice(0, maxDelegations);

					if (iteration.delegationRequests.length > maxDelegations) {
						this.logger.warn("Delegation requests truncated", {
							requested: iteration.delegationRequests.length,
							max: maxDelegations,
						});
					}

					for (const delegationReq of requests) {
						await this.executeDelegation(job, delegationReq, iteration.number);
					}
				} else if (
					iteration.delegationRequests &&
					iteration.delegationRequests.length > 0 &&
					this.delegationDepth >= this.maxDelegationDepth
				) {
					this.logger.warn("Delegation requests ignored — max depth reached", {
						depth: this.delegationDepth,
						maxDepth: this.maxDelegationDepth,
					});
				}

				// Check for fatal errors that make retrying pointless
				if (iteration.fatalError) {
					job.status = "failed";
					job.error = `Fatal: ${iteration.fatalError}`;
					job.completedAt = new Date().toISOString();
					job.duration = Math.round((Date.now() - loopStart) / 1000);
					this.emit("job.failed", job, {
						error: job.error,
						iteration: iteration.number,
					});
					return job;
				}

				// Check for completion promise (detected in executeIteration using clean agent output)
				if (iteration.promiseFound) {
					job.status = "complete";
					job.completedAt = new Date().toISOString();
					job.duration = Math.round((Date.now() - loopStart) / 1000);
					this.emit("job.complete", job, {
						iteration: iteration.number,
						duration: job.duration,
						summary: iteration.summary,
						output: iteration.output,
					});
					return job;
				}

				// Auto-complete conversational responses: if the agent exited cleanly
				// with output but no file changes, plan updates, or delegations,
				// treat the first such iteration as a complete response.
				if (
					iteration.exitCode === 0 &&
					iteration.summary &&
					iteration.filesChanged.length === 0 &&
					!iteration.planUpdate &&
					!iteration.promiseFound &&
					(!iteration.delegationRequests || iteration.delegationRequests.length === 0) &&
					iteration.number === 1
				) {
					job.status = "complete";
					job.completedAt = new Date().toISOString();
					job.duration = Math.round((Date.now() - loopStart) / 1000);
					this.emit("job.complete", job, {
						iteration: iteration.number,
						duration: job.duration,
						summary: iteration.summary,
						output: iteration.output,
					});
					return job;
				}

				// Check for struggle
				const struggle = detectStruggle(job.iterations.history, struggleConfig);
				if (struggle.isStuck) {
					const struggleAction = this.config.runner.struggle.action;

					if (struggleAction === "stop") {
						this.emit("job.stuck", job, {
							iteration: iteration.number,
							struggleIndicators: struggle.indicators,
						});
						job.status = "failed";
						job.error = `Stopped due to struggle: ${struggle.indicators.join(", ")}`;
						job.completedAt = new Date().toISOString();
						job.duration = Math.round((Date.now() - loopStart) / 1000);
						this.emit("job.failed", job, { error: job.error });
						return job;
					}

					// "warn" action: only emit once to avoid spamming
					if (!stuckWarned) {
						stuckWarned = true;
						this.emit("job.stuck", job, {
							iteration: iteration.number,
							struggleIndicators: struggle.indicators,
						});
					}
				} else {
					// Reset warning if agent recovers
					stuckWarned = false;
				}
			}

			// Max iterations reached without completion
			if (job.status === "running") {
				job.status = "failed";
				job.error = "Max iterations reached without completion promise";
				job.completedAt = new Date().toISOString();
				job.duration = Math.round((Date.now() - loopStart) / 1000);
				this.emit("job.failed", job, { error: job.error });
			}
		} finally {
			// Cleanup deployed skills
			if (skillCleanup) {
				try {
					await skillCleanup.cleanup();
					this.logger.info("Skills cleaned up", {
						paths: skillCleanup.deployedPaths,
					});
				} catch (err) {
					this.logger.warn("Skill cleanup failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			// Cleanup sandbox temp HOME
			cleanupTempHome(tempHome);
		}

		return job;
	}
}
