import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
	Job,
	JobIteration,
	RunnerEvent,
	RunnerEventType,
	SkillCleanup,
	SkillDeployment,
} from "@randal/core";
import { type RandalConfig, createLogger } from "@randal/core";
import { buildProcessEnv, cleanupTempHome } from "@randal/credentials";
import { type AgentAdapter, getAdapter } from "./agents/index.js";
import { readAndClearContext } from "./context.js";
import { buildSystemPrompt } from "./prompt-assembly.js";
import { findCompletionPromise, generateToken, wrapCommand } from "./sentinel.js";
import { type StruggleConfig, detectStruggle } from "./struggle.js";

export type EventHandler = (event: RunnerEvent) => void;

export interface RunnerOptions {
	config: RandalConfig;
	configBasePath?: string;
	onEvent?: EventHandler;
	memorySearch?: (query: string) => Promise<string[]>;
	skillSearch?: (query: string) => Promise<SkillDeployment[]>;
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

function createJob(req: JobRequest, config: RandalConfig): Job {
	const id = generateJobId();
	const now = new Date().toISOString();

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
 * Execute a single iteration of the ralph loop.
 * Spawns the agent process, captures output, and parses results.
 */
async function executeIteration(
	job: Job,
	adapter: AgentAdapter,
	env: Record<string, string>,
	systemPrompt: string,
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

	// Collect output
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];

	if (proc.stdout) {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				stdoutChunks.push(decoder.decode(value, { stream: true }));
			}
		} catch {
			// Stream ended
		}
	}

	if (proc.stderr) {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				stderrChunks.push(decoder.decode(value, { stream: true }));
			}
		} catch {
			// Stream ended
		}
	}

	const exitCode = await proc.exited;
	const stdout = stdoutChunks.join("");
	const duration = Math.round((Date.now() - iterStart) / 1000);

	// Parse token usage if adapter supports it
	const tokens = adapter.parseUsage?.(stdout) ?? { input: 0, output: 0 };

	// Check for completion promise
	const promiseFound = findCompletionPromise(
		stdout,
		"DONE", // will be overridden by config in the loop
	);

	// Detect file changes via git diff (simple heuristic)
	const filesChanged = parseFilesChanged(stdout);

	// Extract summary (first meaningful line)
	const summary = extractSummary(stdout);

	return {
		number: iterNum,
		startedAt: new Date(iterStart).toISOString(),
		duration,
		filesChanged,
		tokens,
		exitCode,
		promiseFound,
		summary,
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
	private activeJobs: Map<string, { job: Job; aborted: boolean }> = new Map();
	private logger = createLogger({ context: { component: "runner" } });

	constructor(options: RunnerOptions) {
		this.config = options.config;
		this.configBasePath = options.configBasePath ?? ".";
		this.onEvent = options.onEvent ?? (() => {});
		this.memorySearch = options.memorySearch;
		this.skillSearch = options.skillSearch;
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
	 * Stop a running job.
	 */
	stop(jobId: string): boolean {
		const entry = this.activeJobs.get(jobId);
		if (!entry) return false;
		entry.aborted = true;
		entry.job.status = "stopped";
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
					} catch {
						// Memory search failed, continue without it
					}
				}

				// Build system prompt
				const systemPrompt = await buildSystemPrompt(this.config, this.configBasePath, {
					memoryContext,
					injectedContext: injectedContext ?? undefined,
					skillContext,
				});

				this.emit("iteration.start", job, {
					iteration: i + 1,
					maxIterations: job.maxIterations,
				});

				// Execute iteration
				const iteration = await executeIteration(job, adapter, env, systemPrompt);

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

				// Check for completion promise
				if (
					findCompletionPromise(
						job.iterations.history.map((h) => h.summary).join("\n"),
						this.config.runner.completionPromise,
					) ||
					iteration.promiseFound
				) {
					job.status = "complete";
					job.completedAt = new Date().toISOString();
					job.duration = Math.round((Date.now() - loopStart) / 1000);
					this.emit("job.complete", job, {
						iteration: iteration.number,
						duration: job.duration,
					});
					return job;
				}

				// Check for struggle
				const struggle = detectStruggle(job.iterations.history, struggleConfig);
				if (struggle.isStuck) {
					this.emit("job.stuck", job, {
						iteration: iteration.number,
						struggleIndicators: struggle.indicators,
					});
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
