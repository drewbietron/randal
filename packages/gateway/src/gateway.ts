import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RandalConfig, RunnerEvent, RunnerEventType } from "@randal/core";
import { createLogger } from "@randal/core";
import {
	MemoryManager,
	MessageManager,
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
import { listJobs, saveJob, updateJob } from "./jobs.js";

export interface GatewayOptions {
	config: RandalConfig;
	port?: number;
	configBasePath?: string;
	onUpdate?: () => Promise<string>;
}

export interface Gateway {
	stop: () => void;
	port: number;
	broadcast: (message: string) => void;
}

const logger = createLogger({ context: { component: "gateway" } });

/** Wait for Meilisearch to become reachable, retrying with backoff. */
async function waitForMeilisearch(
	url: string,
	apiKey: string | undefined,
	maxAttempts = 15,
	intervalMs = 2000,
): Promise<void> {
	const client = new MeiliSearch({ host: url, apiKey });
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await client.health();
			return;
		} catch {
			if (attempt === maxAttempts) {
				throw new Error(
					`Meilisearch not reachable at ${url} after ${maxAttempts} attempts (${(maxAttempts * intervalMs) / 1000}s)`,
				);
			}
			logger.info("Waiting for Meilisearch...", { attempt, maxAttempts, url });
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
	const { config, configBasePath } = options;
	const eventBus = new EventBus();

	// Wait for Meilisearch to be reachable before initializing managers.
	// This handles the launchd race condition where the gateway starts
	// before Meilisearch is listening.
	try {
		await waitForMeilisearch(config.memory.url, config.memory.apiKey);
		logger.info("Meilisearch is reachable", { url: config.memory.url });
	} catch (err) {
		logger.error("Meilisearch unavailable — message history will not work this session", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Initialize memory manager (Meilisearch-backed)
	let memoryManager: MemoryManager | undefined;
	try {
		memoryManager = new MemoryManager({ config });
		await memoryManager.init();
		logger.info("Memory manager initialized", { url: config.memory.url });
	} catch (err) {
		logger.warn("Memory manager initialization failed, continuing without memory", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Initialize message history manager (Meilisearch-backed)
	let messageManager: MessageManager | undefined;
	try {
		messageManager = new MessageManager({ config });
		await messageManager.init();
		logger.info("Message history initialized");
	} catch (err) {
		logger.warn("Message history initialization failed, continuing without message history", {
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

	// Create HTTP app — pass scheduler, skillManager, messageManager, and posseClient
	const app = createHttpApp({
		config,
		runner,
		eventBus,
		memoryManager,
		messageManager,
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
		messageManager,
		scheduler,
		skillManager,
		onUpdate: options.onUpdate,
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

	// Write PID file for process management
	const pidDir = resolve(process.env.HOME ?? ".", ".randal");
	const pidFile = resolve(pidDir, "gateway.pid");
	try {
		mkdirSync(pidDir, { recursive: true });
		writeFileSync(pidFile, String(process.pid));
	} catch {
		logger.warn("Failed to write PID file", { pidFile });
	}

	// Resume interrupted jobs from previous gateway run
	const interruptedJobs = [
		...listJobs("running" as import("@randal/core").JobStatus),
		...listJobs("queued" as import("@randal/core").JobStatus),
	];
	if (interruptedJobs.length > 0) {
		logger.info("Found interrupted jobs to resume", { count: interruptedJobs.length });
		for (const job of interruptedJobs) {
			try {
				job.updates.push(`Gateway restarted — resuming from iteration ${job.iterations.current}`);
				const { done } = runner.resume(job);
				done
					.then((completed) => {
						saveJob(completed);
						logger.info("Resumed job completed", { jobId: completed.id, status: completed.status });
					})
					.catch((err) => {
						logger.error("Resumed job failed", {
							jobId: job.id,
							error: err instanceof Error ? err.message : String(err),
						});
					});

				// Recover channel adapter state so job completions route correctly
				if (job.origin?.replyTo) {
					for (const ch of channelAdapters) {
						if (ch.name === job.origin.channel && ch.recoverJob) {
							ch.recoverJob(job.id, job.origin.replyTo).catch((err) => {
								logger.warn("Channel recovery failed for resumed job", {
									jobId: job.id,
									channel: ch.name,
									error: err instanceof Error ? err.message : String(err),
								});
							});
						}
					}
				}

				logger.info("Resumed interrupted job", {
					jobId: job.id,
					iteration: job.iterations.current,
				});
			} catch (err) {
				// If resume fails, mark the job as failed so it's not retried forever
				logger.error("Failed to resume job, marking as failed", {
					jobId: job.id,
					error: err instanceof Error ? err.message : String(err),
				});
				updateJob(job.id, {
					status: "failed",
					error: `Failed to resume after gateway restart: ${err instanceof Error ? err.message : String(err)}`,
					completedAt: new Date().toISOString(),
				});
			}
		}
	}

	logger.info("Gateway started", {
		name: config.name,
		port,
		posse: config.posse,
	});

	console.log(`Randal gateway started: http://localhost:${port}`);
	console.log(`Dashboard: http://localhost:${port}/`);
	console.log(`PID: ${process.pid} (${pidFile})`);
	if (interruptedJobs.length > 0) {
		console.log(`Resumed ${interruptedJobs.length} interrupted job(s)`);
	}

	return {
		stop: () => {
			// Remove PID file
			try {
				unlinkSync(pidFile);
			} catch {
				/* already removed */
			}
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
		broadcast: (message: string) => {
			eventBus.emit({
				type: "system.update" as RunnerEventType,
				jobId: "system",
				timestamp: new Date().toISOString(),
				data: { message },
			});
		},
	};
}
