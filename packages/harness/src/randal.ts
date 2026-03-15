import { existsSync } from "node:fs";
import type { RandalConfig } from "@randal/core";
import { configSchema, createLogger, loadConfig, parseConfig } from "@randal/core";
import { type Gateway, startGateway } from "@randal/gateway";
import { MemoryManager, type MemoryStore } from "@randal/memory";
import { Runner } from "@randal/runner";
import { Scheduler } from "@randal/scheduler";

// ---- Types ----

export interface RandalInstance {
	/** The resolved, frozen config */
	config: RandalConfig;

	/** The runner — submit and manage jobs */
	runner: Runner;

	/** The HTTP gateway — API, SSE, dashboard */
	gateway?: Gateway;

	/** The scheduler — heartbeat, cron, hooks */
	scheduler: Scheduler;

	/** The memory manager (if configured) */
	memory?: MemoryManager;

	/** Shut everything down cleanly */
	stop: () => void;
}

export interface CreateRandalOptions {
	/** Path to a randal.config.yaml file */
	configPath?: string;

	/** Raw YAML string to parse as config */
	configYaml?: string;

	/** Partial config object — merged with defaults */
	config?: Record<string, unknown>;

	/** Override the gateway port */
	port?: number;

	/** Skip starting the scheduler (heartbeat/cron/hooks) */
	skipScheduler?: boolean;

	/** Skip starting the gateway HTTP server */
	skipGateway?: boolean;

	/** Provide a custom MemoryStore implementation (advanced).
	 *  When provided, this store is used instead of the config-driven default. */
	memoryStore?: MemoryStore;

	/** Event handler for runner events */
	onEvent?: (event: import("@randal/core").RunnerEvent) => void;
}

// ---- Implementation ----

/**
 * Boot the entire Randal engine.
 *
 * Usage:
 *   const randal = await createRandal({ configPath: "./randal.config.yaml" });
 *   // randal is now running: gateway, runner, scheduler, memory
 *   // ...
 *   randal.stop();
 */
export async function createRandal(opts: CreateRandalOptions): Promise<RandalInstance> {
	// 1. Resolve config
	let config: RandalConfig;
	if (opts.configPath) {
		config = loadConfig(opts.configPath);
	} else if (opts.configYaml) {
		config = parseConfig(opts.configYaml);
	} else if (opts.config) {
		config = configSchema.parse(opts.config) as RandalConfig;
	} else {
		throw new Error("createRandal requires one of: configPath, configYaml, or config object");
	}

	// 2. Warn if running outside a container without sandbox enforcement
	if (config.sandbox.enforcement === "none") {
		const inContainer =
			existsSync("/.dockerenv") ||
			!!process.env.RAILWAY_ENVIRONMENT ||
			!!process.env.KUBERNETES_SERVICE_HOST;

		if (!inContainer) {
			const logger = createLogger({ context: { component: "harness" } });
			logger.warn(
				"Running without container isolation and sandbox.enforcement is 'none'. " +
					"The agent will have full access to this machine's filesystem and credentials. " +
					"Set sandbox.enforcement to 'env-scrub' or run inside a container for production use.",
			);
		}
	}

	// 3. Initialize memory manager
	const harnessLogger = createLogger({ context: { component: "harness" } });
	let memoryManager: MemoryManager | undefined;
	try {
		memoryManager = new MemoryManager({
			config,
			basePath: ".",
			store: opts.memoryStore,
		});
		await memoryManager.init();
	} catch (err) {
		harnessLogger.warn("Memory initialization failed, continuing without memory", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 4. Create Runner
	const eventHandler = opts.onEvent ?? (() => {});
	const runner = new Runner({
		config,
		onEvent: eventHandler,
		memorySearch: memoryManager
			? async (query: string) => {
					const mgr = memoryManager;
					if (!mgr) return [];
					return (await mgr.searchForContext(query)) ?? [];
				}
			: undefined,
	});

	// 5. Create Scheduler
	const scheduler = new Scheduler({
		config,
		runner,
		onEvent: eventHandler,
		memorySearch: memoryManager
			? async (query: string) => {
					const mgr = memoryManager;
					if (!mgr) return [];
					return (await mgr.searchForContext(query)) ?? [];
				}
			: undefined,
	});

	// 6. Start gateway (if not skipped)
	let gateway: Gateway | undefined;
	if (!opts.skipGateway) {
		gateway = await startGateway({
			config,
			port: opts.port,
		});
	}

	// 7. Start scheduler (if not skipped)
	if (!opts.skipScheduler) {
		await scheduler.start();
	}

	// 8. Return instance with stop()
	return {
		config,
		runner,
		gateway,
		scheduler,
		memory: memoryManager,
		stop: () => {
			// Stop all active runner jobs
			for (const job of runner.getActiveJobs()) {
				runner.stop(job.id);
			}
			scheduler.stop();
			gateway?.stop();
		},
	};
}
