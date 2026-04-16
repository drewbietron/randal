import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MeilisearchAnnotationStore } from "@randal/analytics";
import type { MeshInstance, RandalConfig, RunnerEvent, RunnerEventType } from "@randal/core";
import { createLogger } from "@randal/core";
import { EmbeddingService } from "@randal/memory";
import {
	MemoryManager,
	MessageManager,
	SkillManager,
	deregisterAgent,
	registerAgent,
	updateHeartbeat,
} from "@randal/memory";
import {
	HealthMonitor,
	MeilisearchMeshRegistry,
	createInstanceFromConfig,
	dryRunRoute,
} from "@randal/mesh";
import { Runner } from "@randal/runner";
import { Scheduler } from "@randal/scheduler";
import { MeiliSearch } from "meilisearch";
import { AnalyticsEngineFacade } from "./analytics-facade.js";
import type { ChannelAdapter, ChannelDeps } from "./channels/channel.js";
import { DependencyError, createChannel } from "./channels/factory.js";
import { createHttpApp } from "./channels/http.js";
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
	logger.info("Initializing MeiliSearch client", { url, urlType: typeof url, urlValue: JSON.stringify(url) });
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

/**
 * Resolve the mesh.expertise config field to plain text.
 * Supports inline string, file reference, or combined format.
 * Never throws — returns undefined on any failure.
 */
function resolveExpertiseText(config: RandalConfig): string | undefined {
	try {
		const expertise = config.mesh.expertise;
		if (!expertise) return undefined;
		if (typeof expertise === "string") return expertise;
		// Object form: { file: string, additional?: string }
		let text = "";
		if (expertise.file) {
			const filePath = resolve(expertise.file);
			text = readFileSync(filePath, "utf-8");
		}
		if (expertise.additional) {
			text = text ? `${text}\n\n${expertise.additional}` : expertise.additional;
		}
		return text || undefined;
	} catch (err) {
		logger.warn("Failed to resolve expertise text", {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
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

	// Initialize annotation store for analytics (if enabled)
	let annotationStore: MeilisearchAnnotationStore | undefined;
	let analyticsEngine: AnalyticsEngineFacade | undefined;
	if (config.analytics?.enabled) {
		try {
			const meiliClient = new MeiliSearch({
				host: config.memory.url,
				apiKey: config.memory.apiKey,
			});
			annotationStore = new MeilisearchAnnotationStore(meiliClient, config.name);
			await annotationStore.init();
			logger.info("Annotation store initialized");
		} catch (err) {
			logger.warn("Annotation store init failed, continuing without analytics", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
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

	// Create runner with event forwarding to event bus.
	// Brain session handles memory and skills internally via MCP tools.
	const runner = new Runner({
		config,
		configBasePath,
		onEvent,
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

	// Create analytics facade (needs runner for job lookups in addAnnotation)
	if (annotationStore) {
		analyticsEngine = new AnalyticsEngineFacade(annotationStore, runner, config);
		await analyticsEngine.warmup();
	}

	// ── Wire mesh coordinator (optional, non-fatal) ──
	let meshRegistry: MeilisearchMeshRegistry | undefined;
	let healthMonitor: HealthMonitor | undefined;
	let selfInstance: MeshInstance | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: meshCoordinator shape is defined by HttpChannelOptions
	let meshCoordinator: any;

	// Cached expertise data for posse registration and heartbeats
	let resolvedExpertiseCache: string | undefined;
	let expertiseVectorCache: number[] | undefined;

	if (config.mesh.enabled && posseClient) {
		try {
			meshRegistry = new MeilisearchMeshRegistry(posseClient, config.posse ?? config.name);
			await meshRegistry.init();

			// Resolve expertise text and embed it (non-fatal)
			resolvedExpertiseCache = resolveExpertiseText(config);
			let meshEmbedding: EmbeddingService | undefined;
			if (process.env.OPENROUTER_API_KEY) {
				try {
					meshEmbedding = new EmbeddingService({
						apiKey: process.env.OPENROUTER_API_KEY,
					});
					if (resolvedExpertiseCache) {
						const vector = await meshEmbedding.embed(resolvedExpertiseCache).catch(() => null);
						expertiseVectorCache = vector ?? undefined;
					}
				} catch {
					// Embedding init or call failed — non-fatal, fall back to role matching
				}
			}

			selfInstance = createInstanceFromConfig(config, {
				resolvedExpertise: resolvedExpertiseCache,
				expertiseVector: expertiseVectorCache,
			});
			await meshRegistry.register(selfInstance);

			healthMonitor = new HealthMonitor();
			const registry = meshRegistry;
			healthMonitor.start(
				() => registry.discover(),
				(result) => {
					if (!result.healthy) {
						logger.debug("Peer health check failed", {
							instanceId: result.instanceId,
							error: result.error,
						});
					}
				},
			);

			// Build meshCoordinator adapter expected by HTTP app
			meshCoordinator = {
				getInstances: () => {
					// Return cached instances (sync) — discover is async, so
					// we'll populate on first call and cache briefly
					return [];
				},
				routeDryRun: (_prompt: string) => {
					// Synchronous routing not feasible without cached instances;
					// use the /mesh/route endpoint directly for async routing
					return {
						selectedInstance: { id: "", name: "", score: 0 },
						scores: [],
					};
				},
			};

			// Warm the mesh coordinator with a discover call
			meshRegistry
				.discover()
				.then((instances) => {
					meshCoordinator.getInstances = () =>
						instances.map((inst: MeshInstance) => ({
							id: inst.instanceId,
							name: inst.name,
							status: inst.status,
							health: inst.health.missedPings > 0 ? "degraded" : "healthy",
							load: inst.activeJobs,
							role: inst.role ?? "",
							expertise: inst.expertise ?? "",
							lastSeen: inst.lastHeartbeat,
						}));

					meshCoordinator.routeDryRun = async (prompt: string) => {
						// Embed the task prompt for semantic scoring (non-fatal)
						const taskVector = meshEmbedding
							? await meshEmbedding.embed(prompt).catch(() => null)
							: null;
						const decisions = dryRunRoute(instances, {
							prompt,
							taskVector: taskVector ?? undefined,
						});
						const best = decisions[0];
						return {
							selectedInstance: best
								? { id: best.instance.instanceId, name: best.instance.name, score: best.score }
								: { id: "", name: "", score: 0 },
							scores: decisions.map((d) => ({
								id: d.instance.instanceId,
								name: d.instance.name,
								score: d.score,
								breakdown: d.breakdown,
							})),
						};
					};
				})
				.catch((err) => {
					logger.warn("Initial mesh discover failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				});

			logger.info("Mesh coordinator initialized", {
				posse: config.posse ?? config.name,
				instanceId: selfInstance.instanceId,
				expertise: !!resolvedExpertiseCache,
				vector: !!expertiseVectorCache,
			});
		} catch (err) {
			logger.warn("Mesh coordinator initialization failed, continuing without mesh", {
				error: err instanceof Error ? err.message : String(err),
			});
			meshRegistry = undefined;
			healthMonitor = undefined;
			selfInstance = undefined;
			meshCoordinator = undefined;
		}
	}

	// Mutable adapter registry — populated after channel start, accessed at request time
	const channelAdapters: ChannelAdapter[] = [];

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
		analyticsEngine,
		channelAdapters,
		meshCoordinator,
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
	for (const channelConfig of config.gateway.channels) {
		if (channelConfig.type === "http") continue; // Handled by createHttpApp above

		try {
			const { adapter, webhookRouter } = await createChannel(channelConfig, channelDeps);

			// Mount webhook routes before start() so endpoints are ready
			if (webhookRouter) {
				app.route(webhookRouter.path, webhookRouter.router);
			}

			await adapter.start();
			channelAdapters.push(adapter);
			logger.info("Channel started", { type: channelConfig.type });
		} catch (err) {
			if (err instanceof DependencyError) {
				logger.warn("Channel skipped — missing dependency", {
					type: channelConfig.type,
					package: err.packageName,
					install: `bun add ${err.packageName}`,
				});
			} else {
				// Non-fatal — HTTP and other channels continue working
				logger.error("Channel failed to start", {
					type: channelConfig.type,
					error: err instanceof Error ? err.message : String(err),
				});
			}
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

	// Ensure config.mesh.endpoint is set so the posse registry doc includes
	// a reachable URL for this agent's gateway (used by delegate_task).
	// Create a new config object to avoid mutating the frozen original
	let effectiveConfig = config;
	if (config.mesh && !config.mesh.endpoint) {
		effectiveConfig = {
			...config,
			mesh: {
				...config.mesh,
				endpoint: `http://localhost:${server.port}`,
			},
		};
	}

	// Register in posse registry (R3.3)
	if (posseClient && config.posse) {
		try {
			await registerAgent(effectiveConfig, posseClient, {
				resolvedExpertise: resolvedExpertiseCache,
				expertiseVector: expertiseVectorCache,
			});
			logger.info("Registered in posse registry", {
				posse: config.posse,
				endpoint: effectiveConfig.mesh?.endpoint,
			});
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
					await updateHeartbeat(config, posseClient, status as "idle" | "busy", {
						resolvedExpertise: resolvedExpertiseCache,
						expertiseVector: expertiseVectorCache,
					});
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
			// Stop mesh coordinator
			if (healthMonitor) {
				healthMonitor.stop();
			}
			if (meshRegistry && selfInstance) {
				meshRegistry.deregister(selfInstance.instanceId).catch(() => {});
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
