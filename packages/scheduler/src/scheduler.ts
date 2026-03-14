import type { RandalConfig, RunnerEvent } from "@randal/core";
import { createLogger } from "@randal/core";
import type { Runner } from "@randal/runner";
import type { Hono } from "hono";
import { type CronJobState, CronScheduler } from "./cron.js";
import { Heartbeat, type HeartbeatConfig, type HeartbeatState } from "./heartbeat.js";
import { createHooksRouter } from "./hooks.js";

// ---- Types ----

export interface SchedulerOptions {
	config: RandalConfig;
	runner: Runner;
	onEvent?: (event: RunnerEvent) => void;
	configBasePath?: string;
	memorySearch?: (query: string) => Promise<string[]>;
}

export interface SchedulerStatus {
	heartbeat: HeartbeatState;
	cron: CronJobState[];
	hooks: { enabled: boolean; pendingItems: number };
}

// ---- Scheduler class ----

const logger = createLogger({ context: { component: "scheduler" } });

export class Scheduler {
	private heartbeat: Heartbeat;
	private cron: CronScheduler;
	private hooksRouter: Hono;
	private config: RandalConfig;

	constructor(options: SchedulerOptions) {
		const { config, runner, onEvent, configBasePath, memorySearch } = options;
		this.config = config;

		// Build heartbeat config from the RandalConfig
		const heartbeatConfig: HeartbeatConfig = {
			enabled: config.heartbeat.enabled,
			every: config.heartbeat.every,
			prompt: config.heartbeat.prompt,
			activeHours: config.heartbeat.activeHours,
			target: config.heartbeat.target,
			model: config.heartbeat.model,
		};

		// Create heartbeat
		this.heartbeat = new Heartbeat({
			config: heartbeatConfig,
			runner,
			onEvent,
			configBasePath,
			memorySearch,
		});

		// Create cron scheduler
		this.cron = new CronScheduler({
			jobs: config.cron.jobs,
			runner,
			heartbeat: this.heartbeat,
			onEvent,
		});

		// Create hooks router
		this.hooksRouter = createHooksRouter({
			token: config.hooks.token,
			heartbeat: this.heartbeat,
			runner,
			onEvent,
		});
	}

	/**
	 * Start heartbeat timer and register cron jobs.
	 */
	async start(): Promise<void> {
		if (this.config.heartbeat.enabled) {
			this.heartbeat.start();
			logger.info("Heartbeat enabled", { every: this.config.heartbeat.every });
		}

		this.cron.start();

		const cronJobs = this.cron.listJobs();
		if (cronJobs.length > 0) {
			logger.info("Cron jobs registered", {
				count: cronJobs.length,
				names: cronJobs.map((j) => j.name),
			});
		}

		if (this.config.hooks.enabled) {
			logger.info("Hooks enabled", { path: this.config.hooks.path });
		}
	}

	/**
	 * Stop all timers.
	 */
	stop(): void {
		this.heartbeat.stop();
		this.cron.stop();
		logger.info("Scheduler stopped");
	}

	/**
	 * Get full scheduler status.
	 */
	getStatus(): SchedulerStatus {
		return {
			heartbeat: this.heartbeat.getState(),
			cron: this.cron.listJobs(),
			hooks: {
				enabled: this.config.hooks.enabled,
				pendingItems: this.heartbeat.getState().pendingWakeItems.length,
			},
		};
	}

	/**
	 * Get the hooks router for mounting on gateway.
	 */
	getHooksRouter(): Hono {
		return this.hooksRouter;
	}

	/**
	 * Access heartbeat for direct control.
	 */
	getHeartbeat(): Heartbeat {
		return this.heartbeat;
	}

	/**
	 * Access cron for direct control.
	 */
	getCron(): CronScheduler {
		return this.cron;
	}
}
