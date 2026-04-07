import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
	DelegationRequest,
	DelegationResult,
	Job,
	JobOrigin,
	RunnerEvent,
	RunnerEventType,
	SkillDeployment,
} from "@randal/core";
import { type RandalConfig, createLogger } from "@randal/core";
import { buildProcessEnv, cleanupTempHome } from "@randal/credentials";
import { getAdapter } from "./agents/index.js";
import { readAndClearContext } from "./context.js";
import { syncJobToLoopState } from "./loop-state.js";
import { buildSystemPrompt } from "./prompt-assembly.js";
import { findCompletionPromise, generateToken, parseOutput, wrapCommand } from "./sentinel.js";
import { type StreamingResult, readStreamLines } from "./streaming.js";
import { detectFatalError } from "./struggle.js";

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

			// Build minimal prompt — brain has its own persona/rules/knowledge.
			// Only channel context is injected (if any).
			const systemPrompt = await buildSystemPrompt(this.config, this.configBasePath, {
				injectedContext: injectedContext ?? undefined,
			});

			const prompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${job.prompt}` : job.prompt;

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
				return job;
			}

			// Edge case: empty output with exit code 0 = failure (likely TUI mode or binary not found)
			if (!agentOutput.trim() && sentinelExitCode === 0) {
				job.status = "failed";
				job.error = "Brain session produced no output (possible misconfiguration)";
				job.exitCode = sentinelExitCode;
				job.completedAt = new Date().toISOString();
				job.duration = duration;
				syncJobToLoopState(job);
				this.emit("job.failed", job, { error: job.error });
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
			return job;
		} finally {
			cleanupTempHome(tempHome);
		}
	}

	private async runLoop(job: Job): Promise<Job> {
		return this.runBrainSession(job);
	}
}
