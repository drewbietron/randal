import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, resolvePromptValue } from "@randal/core";
import type { PromptContext, RunnerEvent } from "@randal/core";
import type { Runner } from "@randal/runner";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Heartbeat, WakeItem } from "./heartbeat.js";

// ---- Types ----

export interface CronJobConfig {
	name: string;
	schedule: string | { every: string } | { at: string };
	prompt: string;
	execution: "main" | "isolated";
	model?: string;
	announce: boolean;
}

export interface CronJobState {
	name: string;
	config: CronJobConfig;
	lastRun: string | null;
	nextRun: string | null;
	runCount: number;
	status: "active" | "completed" | "paused";
}

export type CronEventHandler = (event: RunnerEvent) => void;

export interface CronSchedulerOptions {
	jobs: Record<string, Omit<CronJobConfig, "name">>;
	runner: Runner;
	heartbeat?: Heartbeat;
	onEvent?: CronEventHandler;
	/** Directory containing the config file (for prompt file resolution) */
	configBasePath?: string;
	/** Template variables for prompt resolution (from identity.vars + auto-populated) */
	promptVars?: Record<string, string>;
}

// ---- Cron expression matching ----

/**
 * Parse a 5-field cron expression and check if the current time matches.
 * Fields: minute hour day-of-month month day-of-week
 * Supports: *, specific numbers, ranges (1-5), steps (*\/5), lists (1,3,5)
 */
export function matchesCronExpression(expression: string, date: Date): boolean {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) return false;

	const minute = date.getMinutes();
	const hour = date.getHours();
	const dayOfMonth = date.getDate();
	const month = date.getMonth() + 1; // 1-indexed
	const dayOfWeek = date.getDay(); // 0 = Sunday

	return (
		matchesField(fields[0], minute, 0, 59) &&
		matchesField(fields[1], hour, 0, 23) &&
		matchesField(fields[2], dayOfMonth, 1, 31) &&
		matchesField(fields[3], month, 1, 12) &&
		matchesField(fields[4], dayOfWeek, 0, 7) // 0 and 7 both = Sunday
	);
}

function matchesField(field: string, value: number, min: number, max: number): boolean {
	// Handle day-of-week where 7 === 0 (Sunday) — normalize both value and field numbers
	const isDow = max === 7;
	const normalizedValue = isDow && value === 7 ? 0 : value;

	// Helper to normalize a DOW number (7 → 0)
	const normNum = (n: number) => (isDow && n === 7 ? 0 : n);

	// Handle list (comma-separated)
	if (field.includes(",")) {
		return field.split(",").some((part) => matchesField(part.trim(), normalizedValue, min, max));
	}

	// Handle wildcard
	if (field === "*") return true;

	// Handle step (*/N or range/N)
	if (field.includes("/")) {
		const [rangeStr, stepStr] = field.split("/");
		const step = Number.parseInt(stepStr, 10);
		if (Number.isNaN(step) || step <= 0) return false;

		if (rangeStr === "*") {
			return normalizedValue % step === 0;
		}

		if (rangeStr.includes("-")) {
			const [startStr, endStr] = rangeStr.split("-");
			const start = normNum(Number.parseInt(startStr, 10));
			const end = normNum(Number.parseInt(endStr, 10));
			if (normalizedValue < start || normalizedValue > end) return false;
			return (normalizedValue - start) % step === 0;
		}

		const start = normNum(Number.parseInt(rangeStr, 10));
		if (normalizedValue < start) return false;
		return (normalizedValue - start) % step === 0;
	}

	// Handle range (N-M)
	if (field.includes("-")) {
		const [startStr, endStr] = field.split("-");
		const start = normNum(Number.parseInt(startStr, 10));
		const end = normNum(Number.parseInt(endStr, 10));
		return normalizedValue >= start && normalizedValue <= end;
	}

	// Handle specific number
	const num = normNum(Number.parseInt(field, 10));
	return normalizedValue === num;
}

// ---- Duration parsing (reuse from heartbeat) ----

import { parseDuration } from "./heartbeat.js";

// ---- Persistence ----

const CRON_STATE_DIR = join(homedir(), ".randal");
const CRON_STATE_FILE = join(CRON_STATE_DIR, "cron.yaml");

interface PersistedCronState {
	jobs: Record<
		string,
		{
			lastRun: string | null;
			runCount: number;
			status: string;
		}
	>;
}

function loadPersistedState(): PersistedCronState {
	try {
		if (existsSync(CRON_STATE_FILE)) {
			const raw = readFileSync(CRON_STATE_FILE, "utf-8");
			const parsed = parseYaml(raw) as PersistedCronState;
			return parsed ?? { jobs: {} };
		}
	} catch {
		// Ignore read errors
	}
	return { jobs: {} };
}

function savePersistedState(state: PersistedCronState): void {
	try {
		if (!existsSync(CRON_STATE_DIR)) {
			mkdirSync(CRON_STATE_DIR, { recursive: true });
		}
		// Atomic write: write to temp file then rename
		const tmp = `${CRON_STATE_FILE}.tmp`;
		writeFileSync(tmp, stringifyYaml(state), "utf-8");
		renameSync(tmp, CRON_STATE_FILE);
	} catch {
		// Ignore write errors — persistence is best-effort
	}
}

// ---- CronScheduler class ----

const logger = createLogger({ context: { component: "cron" } });

export class CronScheduler {
	private runner: Runner;
	private heartbeat?: Heartbeat;
	private onEvent: CronEventHandler;
	private configBasePath: string;
	private promptVars?: Record<string, string>;
	private jobStates: Map<string, CronJobState> = new Map();
	private timers: Map<string, ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> =
		new Map();
	private cronCheckTimer: ReturnType<typeof setInterval> | null = null;
	private cronExpressionJobs: Set<string> = new Set();

	constructor(options: CronSchedulerOptions) {
		this.runner = options.runner;
		this.heartbeat = options.heartbeat;
		this.onEvent = options.onEvent ?? (() => {});
		this.configBasePath = options.configBasePath ?? ".";
		this.promptVars = options.promptVars;

		// Load persisted state
		const persisted = loadPersistedState();

		// Register jobs from config
		for (const [name, jobConfig] of Object.entries(options.jobs)) {
			const config: CronJobConfig = { name, ...jobConfig };
			const persistedJob = persisted.jobs[name];

			this.jobStates.set(name, {
				name,
				config,
				lastRun: persistedJob?.lastRun ?? null,
				nextRun: null,
				runCount: persistedJob?.runCount ?? 0,
				status: (persistedJob?.status as CronJobState["status"]) ?? "active",
			});
		}
	}

	/**
	 * Start all registered cron jobs.
	 */
	start(): void {
		for (const [name, state] of this.jobStates.entries()) {
			if (state.status !== "active") continue;
			this.startJob(name, state.config);
		}

		// Start a 60-second check timer for cron expression jobs
		if (this.cronExpressionJobs.size > 0) {
			this.cronCheckTimer = setInterval(() => {
				this.checkCronExpressions();
			}, 60_000);
		}

		logger.info("Cron scheduler started", {
			jobCount: this.jobStates.size,
		});
	}

	/**
	 * Stop all timers and clean up.
	 */
	stop(): void {
		for (const timer of this.timers.values()) {
			clearInterval(timer as ReturnType<typeof setInterval>);
			clearTimeout(timer as ReturnType<typeof setTimeout>);
		}
		this.timers.clear();

		if (this.cronCheckTimer) {
			clearInterval(this.cronCheckTimer);
			this.cronCheckTimer = null;
		}

		this.cronExpressionJobs.clear();
		logger.info("Cron scheduler stopped");
	}

	/**
	 * Add a job at runtime.
	 */
	addJob(config: CronJobConfig): void {
		const { name } = config;

		// Remove existing job with same name if any
		if (this.jobStates.has(name)) {
			this.removeJob(name);
		}

		const state: CronJobState = {
			name,
			config,
			lastRun: null,
			nextRun: null,
			runCount: 0,
			status: "active",
		};

		this.jobStates.set(name, state);
		this.startJob(name, config);
		this.persistState();

		this.emitEvent("cron.added", { cronJobName: name });
		logger.info("Cron job added", { name });
	}

	/**
	 * Remove a job at runtime.
	 */
	removeJob(name: string): boolean {
		const state = this.jobStates.get(name);
		if (!state) return false;

		// Clear timer
		const timer = this.timers.get(name);
		if (timer) {
			clearInterval(timer as ReturnType<typeof setInterval>);
			clearTimeout(timer as ReturnType<typeof setTimeout>);
			this.timers.delete(name);
		}

		this.cronExpressionJobs.delete(name);
		this.jobStates.delete(name);
		this.persistState();

		this.emitEvent("cron.removed", { cronJobName: name });
		logger.info("Cron job removed", { name });

		return true;
	}

	/**
	 * List all registered jobs and their states.
	 */
	listJobs(): CronJobState[] {
		return [...this.jobStates.values()];
	}

	/**
	 * Get a specific job's state.
	 */
	getJob(name: string): CronJobState | undefined {
		return this.jobStates.get(name);
	}

	/**
	 * Start a specific job's timer based on its schedule format.
	 */
	private startJob(name: string, config: CronJobConfig): void {
		const { schedule } = config;

		if (typeof schedule === "string") {
			// Cron expression — register for periodic checking
			this.cronExpressionJobs.add(name);
			const state = this.jobStates.get(name);
			if (state) {
				state.nextRun = "cron-expression";
			}
		} else if ("every" in schedule) {
			// Interval
			const ms = parseDuration(schedule.every);
			const timer = setInterval(() => {
				this.fireJob(name).catch((err) => {
					logger.error("Cron job interval fire failed", {
						name,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}, ms);
			this.timers.set(name, timer);

			const state = this.jobStates.get(name);
			if (state) {
				state.nextRun = new Date(Date.now() + ms).toISOString();
			}
		} else if ("at" in schedule) {
			// One-shot
			const targetTime = new Date(schedule.at).getTime();
			const delay = targetTime - Date.now();

			if (delay <= 0) {
				// Already past, mark as completed
				const state = this.jobStates.get(name);
				if (state) {
					state.status = "completed";
				}
				this.emitEvent("cron.skipped", { cronJobName: name });
				return;
			}

			const timer = setTimeout(() => {
				this.fireJob(name)
					.then(() => {
						const state = this.jobStates.get(name);
						if (state) {
							state.status = "completed";
						}
						this.persistState();
					})
					.catch((err) => {
						logger.error("Cron one-shot fire failed", {
							name,
							error: err instanceof Error ? err.message : String(err),
						});
					});
			}, delay);
			this.timers.set(name, timer);

			const state = this.jobStates.get(name);
			if (state) {
				state.nextRun = schedule.at;
			}
		}
	}

	/**
	 * Check all cron expression jobs against the current time.
	 * Called every 60 seconds.
	 */
	private checkCronExpressions(): void {
		const now = new Date();

		for (const name of this.cronExpressionJobs) {
			const state = this.jobStates.get(name);
			if (!state || state.status !== "active") continue;

			if (
				typeof state.config.schedule === "string" &&
				matchesCronExpression(state.config.schedule, now)
			) {
				this.fireJob(name).catch((err) => {
					logger.error("Cron expression fire failed", {
						name,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		}
	}

	/**
	 * Fire a cron job — either queue to heartbeat (main) or execute directly (isolated).
	 * Resolves the prompt through the shared resolver (supports file refs, code modules, templates).
	 */
	private async fireJob(name: string): Promise<void> {
		const state = this.jobStates.get(name);
		if (!state) return;

		const { config } = state;

		state.lastRun = new Date().toISOString();
		state.runCount++;

		this.emitEvent("cron.fired", { cronJobName: name });
		logger.info("Cron job fired", { name, execution: config.execution });

		// Resolve the prompt through the layered resolver
		const ctx: PromptContext = {
			basePath: this.configBasePath,
			vars: this.promptVars,
			configName: this.promptVars?.name,
		};

		let resolvedPrompt: string;
		try {
			resolvedPrompt = await resolvePromptValue(config.prompt, ctx);
		} catch (err) {
			logger.warn("Cron prompt resolution failed, using raw prompt", {
				name,
				prompt: config.prompt,
				error: err instanceof Error ? err.message : String(err),
			});
			resolvedPrompt = config.prompt;
		}

		if (config.execution === "main" && this.heartbeat) {
			// Queue for next heartbeat
			const wakeItem: WakeItem = {
				text: `[Cron: ${name}] ${resolvedPrompt}`,
				source: "cron",
				timestamp: new Date().toISOString(),
			};
			this.heartbeat.queueWakeItem(wakeItem);
		} else {
			// Execute directly as isolated job
			try {
				await this.runner.execute({
					prompt: resolvedPrompt,
					model: config.model,
					maxIterations: 5,
				});
			} catch (err) {
				logger.warn("Cron isolated job failed", {
					name,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		this.persistState();
	}

	/**
	 * Persist job state to disk.
	 */
	private persistState(): void {
		const state: PersistedCronState = { jobs: {} };

		for (const [name, jobState] of this.jobStates.entries()) {
			state.jobs[name] = {
				lastRun: jobState.lastRun,
				runCount: jobState.runCount,
				status: jobState.status,
			};
		}

		savePersistedState(state);
	}

	private emitEvent(
		type: "cron.fired" | "cron.skipped" | "cron.added" | "cron.removed",
		data: Record<string, unknown>,
	): void {
		this.onEvent({
			type: type as RunnerEvent["type"],
			jobId: "cron",
			timestamp: new Date().toISOString(),
			data: data as RunnerEvent["data"],
		});
	}
}
