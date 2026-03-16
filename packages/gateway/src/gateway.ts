import type { RandalConfig, RunnerEvent } from "@randal/core";
import { createLogger } from "@randal/core";
import {
	MemoryManager,
	SkillManager,
	deregisterAgent,
	registerAgent,
	updateHeartbeat,
} from "@randal/memory";
import { Runner } from "@randal/runner";
import { Scheduler } from "@randal/scheduler";
import { MeiliSearch } from "meilisearch";
import type { ChannelAdapter, ChannelDeps } from "./channels/channel.js";
import { DiscordChannel } from "./channels/discord.js";
import { createHttpApp } from "./channels/http.js";
import { IMessageChannel } from "./channels/imessage.js";
import { EventBus } from "./events.js";
import { saveJob } from "./jobs.js";

export interface GatewayOptions {
	config: RandalConfig;
	port?: number;
	configBasePath?: string;
}

export interface Gateway {
	stop: () => void;
	port: number;
}

const logger = createLogger({ context: { component: "gateway" } });

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
	const { config, configBasePath } = options;
	const eventBus = new EventBus();

	// Initialize memory manager
	let memoryManager: MemoryManager | undefined;
	try {
		memoryManager = new MemoryManager({
			config,
			basePath: configBasePath ?? ".",
		});
		await memoryManager.init();
		logger.info("Memory manager initialized", { url: config.memory.url });
	} catch (err) {
		logger.warn("Memory manager initialization failed, continuing without memory", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Initialize skill manager
	let skillManager: SkillManager | undefined;
	try {
		skillManager = new SkillManager({
			config,
			basePath: configBasePath ?? ".",
			memoryManager,
		});
		await skillManager.init();
		const skills = await skillManager.list();
		logger.info("Skill manager initialized", { skillCount: skills.length });
	} catch (err) {
		logger.warn("Skill manager initialization failed, continuing without skills", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Start skill watcher if auto-discover is enabled
	let skillWatcher: { stop: () => void } | undefined;
	if (config.skills.autoDiscover && skillManager) {
		try {
			skillWatcher = skillManager.startWatcher();
			logger.info("Skill watcher started");
		} catch (err) {
			logger.warn("Skill watcher failed to start", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Event handler shared by runner and scheduler
	const onEvent = (event: RunnerEvent) => {
		eventBus.emit(event);

		// Persist job state on key events
		if (
			event.type === "iteration.end" ||
			event.type === "job.plan_updated" ||
			event.type === "job.delegation.completed" ||
			event.type === "job.complete" ||
			event.type === "job.failed" ||
			event.type === "job.stopped"
		) {
			const job = runner.getJob(event.jobId);
			if (job) saveJob(job);
		}
	};

	// Create runner with event forwarding to event bus
	const runner = new Runner({
		config,
		configBasePath,
		onEvent,
		memorySearch: memoryManager
			? (query: string) => memoryManager?.searchForContext(query)
			: undefined,
		skillSearch: skillManager
			? (query: string) => skillManager?.searchWithOutcomes(query)
			: undefined,
	});

	// Create scheduler
	const scheduler = new Scheduler({
		config,
		runner,
		onEvent,
		configBasePath,
		memorySearch: memoryManager
			? (query: string) => memoryManager?.searchForContext(query)
			: undefined,
	});

	// Detect tools
	for (const tool of config.tools) {
		if (tool.platforms.includes(process.platform as "darwin" | "linux" | "win32")) {
			try {
				const proc = Bun.spawnSync(["which", tool.binary]);
				if (proc.exitCode === 0) {
					logger.info("Tool detected", { tool: tool.name, binary: tool.binary });
				} else {
					logger.warn("Tool not found", { tool: tool.name, binary: tool.binary });
				}
			} catch {
				logger.warn("Tool detection failed", { tool: tool.name });
			}
		}
	}

	// Create Meilisearch client for posse operations (if posse configured)
	// biome-ignore lint/suspicious/noExplicitAny: MeiliSearch client has complex generics, typed loosely for registry operations
	let posseClient: any;
	if (config.posse && config.memory.store === "meilisearch") {
		posseClient = new MeiliSearch({
			host: config.memory.url,
			apiKey: config.memory.apiKey,
		});
	}

	// Create HTTP app — pass scheduler, skillManager, and posseClient
	const app = createHttpApp({
		config,
		runner,
		eventBus,
		memoryManager,
		scheduler,
		skillManager,
		posseClient,
	});

	// Mount hooks router if enabled
	if (config.hooks.enabled) {
		const hooksRouter = scheduler.getHooksRouter();
		app.route(config.hooks.path, hooksRouter);
	}

	// Start scheduler after creating routes
	await scheduler.start();

	// ── Start messaging channel adapters ──
	const channelDeps: ChannelDeps = {
		config,
		runner,
		eventBus,
		memoryManager,
		scheduler,
		skillManager,
	};
	const channelAdapters: ChannelAdapter[] = [];

	for (const channelConfig of config.gateway.channels) {
		try {
			if (channelConfig.type === "discord") {
				const adapter = new DiscordChannel(channelConfig, channelDeps);
				await adapter.start();
				channelAdapters.push(adapter);
				logger.info("Discord channel started");
			} else if (channelConfig.type === "imessage") {
				const adapter = new IMessageChannel(channelConfig, channelDeps);
				// Mount webhook route before start so it's ready for BlueBubbles
				app.route("/webhooks/imessage", adapter.getWebhookRouter());
				await adapter.start();
				channelAdapters.push(adapter);
				logger.info("iMessage channel started", { provider: channelConfig.provider });
			}
		} catch (err) {
			// Non-fatal — HTTP and other channels continue working
			logger.error("Channel failed to start", {
				type: channelConfig.type,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Determine port
	const httpChannel = config.gateway.channels.find((c) => c.type === "http");
	const port = options.port ?? (httpChannel?.type === "http" ? httpChannel.port : 7600);

	// Start server
	const server = Bun.serve({
		port,
		fetch: app.fetch,
	});

	// Register in posse registry (R3.3)
	if (posseClient && config.posse) {
		try {
			await registerAgent(config, posseClient);
			logger.info("Registered in posse registry", { posse: config.posse });
		} catch (err) {
			logger.warn("Posse registration failed, continuing", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Setup posse heartbeat interval (R3.4)
	let posseHeartbeatInterval: ReturnType<typeof setInterval> | undefined;
	if (posseClient && config.posse) {
		posseHeartbeatInterval = setInterval(
			async () => {
				try {
					const activeJobs = runner.getActiveJobs();
					const status = activeJobs.length > 0 ? "busy" : "idle";
					await updateHeartbeat(config, posseClient, status as "idle" | "busy");
				} catch {
					// Non-fatal
				}
			},
			5 * 60 * 1000,
		); // Every 5 minutes
	}

	logger.info("Gateway started", {
		name: config.name,
		port,
		posse: config.posse,
	});

	console.log(`Randal gateway started: http://localhost:${port}`);
	console.log(`Dashboard: http://localhost:${port}/`);

	return {
		stop: () => {
			// Deregister from posse registry (R3.5)
			if (posseClient && config.posse) {
				deregisterAgent(config, posseClient).catch(() => {});
			}
			if (posseHeartbeatInterval) {
				clearInterval(posseHeartbeatInterval);
			}

			for (const ch of channelAdapters) {
				try {
					ch.stop();
				} catch {
					/* already stopping */
				}
			}
			skillWatcher?.stop();
			scheduler.stop();
			server.stop();
			logger.info("Gateway stopped");
		},
		port,
	};
}
