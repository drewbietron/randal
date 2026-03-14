import type { RandalConfig } from "@randal/core";
import { configSchema, loadConfig, parseConfig } from "@randal/core";
import { type Gateway, startGateway } from "@randal/gateway";
import { MemoryManager } from "@randal/memory";
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

	// 2. Initialize memory manager
	let memoryManager: MemoryManager | undefined;
	try {
		memoryManager = new MemoryManager({
			config,
			basePath: ".",
		});
		await memoryManager.init();
	} catch {
		// Memory init failed, continue without it
	}

	// 3. Create Runner
	const runner = new Runner({
		config,
		onEvent: () => {},
		memorySearch: memoryManager
			? (query: string) => memoryManager?.searchForContext(query)
			: undefined,
	});

	// 4. Create Scheduler
	const scheduler = new Scheduler({
		config,
		runner,
		memorySearch: memoryManager
			? (query: string) => memoryManager?.searchForContext(query)
			: undefined,
	});

	// 5. Start gateway (if not skipped)
	let gateway: Gateway | undefined;
	if (!opts.skipGateway) {
		gateway = await startGateway({
			config,
			port: opts.port,
		});
	}

	// 6. Start scheduler (if not skipped)
	if (!opts.skipScheduler) {
		await scheduler.start();
	}

	// 7. Return instance with stop()
	return {
		config,
		runner,
		gateway,
		scheduler,
		memory: memoryManager,
		stop: () => {
			scheduler.stop();
			gateway?.stop();
		},
	};
}
