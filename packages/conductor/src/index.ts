/**
 * Posse Conductor
 *
 * Central orchestration gateway for the Randal distributed agent system.
 * Provides unified HTTP/WebSocket access to a fleet of agents (the "posse")
 * with intelligent routing, health monitoring, and real-time dashboard.
 *
 * @example
 * ```typescript
 * import { Conductor, loadConfig } from '@randal/conductor';
 *
 * const config = await loadConfig('conductor.yaml');
 * const conductor = new Conductor(config);
 * await conductor.start();
 * ```
 */

import { MeiliSearch } from "meilisearch";
import { AgentRegistry } from "./agents/registry.js";
import type { ConductorConfig } from "./config.js";
import { loadConfig, loadConfigFromEnv } from "./config.js";
import { createHttpServer, type HttpGateway } from "./gateway/http.js";
import type { DashboardWebSocket } from "./gateway/websocket.js";
import { TaskRouter } from "./router/index.js";

// Export all types
export type {
	// Configuration
	ConductorMode,
	CORSConfig,
	GatewayConfig,
	AgentDefaults,
	PosseMember,
	PosseConfig,
	ConductorConfigLegacy,
	// Agent Registry
	AgentStatus,
	AgentRecord,
	AgentHealth,
	AgentStats,
	// Task Routing
	RoutingStrategy,
	ChatMessage,
	ChatRequest,
	RouteResult,
	TaskRouter as TaskRouterInterface,
	// Gateway
	HealthResponse,
	PosseCommand,
	PosseCommandResult,
	// Dashboard
	TaskEventType,
	TaskEvent,
	DashboardStats,
	DashboardUpdate,
	// Events
	RegistryEventType,
	RegistryEvent,
	RegistryEventEmitter,
	// Server
	ConductorServer,
	// Utilities
	InferZodSchema,
	Nullable,
	DeepPartial,
} from "./types.js";

// Export errors
export {
	ConductorError,
	NoAgentsAvailableError,
	AgentNotFoundError,
	InvalidConfigError,
} from "./types.js";

// Export configuration module
export {
	conductorConfigSchema,
	loadConfig,
	parseConfig,
	validateConfig,
	validatePartialConfig,
	resolveEnvVars,
	getDefaultSingleConfig,
	getDefaultPosseConfig,
	loadConfigFromEnv,
} from "./config.js";
export type { ConductorConfig, ConfigValidation } from "./config.js";

import type { ConductorServer } from "./types.js";

/**
 * Main Conductor class
 * Orchestrates the gateway, registry, and router
 */
export class Conductor implements ConductorServer<ConductorConfig> {
	readonly config: ConductorConfig;
	private _registry: AgentRegistry | undefined;
	private _router: TaskRouter | undefined;
	private _httpGateway: HttpGateway | undefined;
	private _wsGateway: DashboardWebSocket | undefined;

	constructor(config: ConductorConfig) {
		this.config = config;
	}

	get registry(): AgentRegistry | undefined {
		return this._registry;
	}

	async start(): Promise<void> {
		// 1. If posse mode: set up MeiliSearch, AgentRegistry, initialize, start polling
		if (this.config.mode === "posse" && this.config.posse) {
			const meili = new MeiliSearch({
				host: this.config.posse.meilisearch.url,
				apiKey: this.config.posse.meilisearch.apiKey || undefined,
			});

			this._registry = new AgentRegistry({
				client: meili,
				posseName: this.config.posse.name,
				pollInterval: this.config.posse.discovery.pollInterval,
			});

			await this._registry.initialize();
			this._registry.startPolling();
		}

		// 2. Create TaskRouter
		this._router = new TaskRouter(this.config, this._registry);

		// 3. Create the HTTP server
		this._httpGateway = createHttpServer(
			this.config,
			this._registry,
			this._router as unknown as import("./types.js").TaskRouter,
		);

		// 4. Start the HTTP server
		await this._httpGateway.start();

		// 5. Create WebSocket gateway if we have a registry (posse mode)
		if (this._registry) {
			// WebSocket gateway requires the underlying http.Server instance.
			// The HttpGateway manages it internally; future refactor can expose it.
			console.log(
				"[Conductor] WebSocket gateway requires underlying HTTP server access - skipping for now",
			);
		}

		// 6. Log startup
		const port = this._httpGateway.getPort();
		console.log(`[Conductor] Started in ${this.config.mode} mode on port ${port}`);
	}

	async stop(): Promise<void> {
		// Stop polling
		if (this._registry) {
			this._registry.stopPolling();
		}

		// Stop WebSocket gateway
		if (this._wsGateway) {
			await this._wsGateway.close();
		}

		// Stop HTTP server
		if (this._httpGateway) {
			await this._httpGateway.stop();
		}

		console.log("[Conductor] Stopped");
	}
}

/**
 * Version of the conductor package
 */
export const VERSION = "0.1.0";

/**
 * Default configuration values
 */
export const DEFAULTS = {
	port: 7777,
	host: "0.0.0.0",
	mode: "single" as const,
	defaultModel: "moonshotai/kimi-k2.5",
	healthCheckInterval: 30000,
	timeout: 120000,
	maxRetries: 3,
};

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
	let config: ConductorConfig;

	try {
		config = loadConfig();
	} catch {
		// Fall back to environment-based config
		try {
			config = loadConfigFromEnv();
		} catch (envErr) {
			console.error(
				"Failed to load configuration:",
				envErr instanceof Error ? envErr.message : String(envErr),
			);
			process.exit(1);
		}
	}

	// Respect PORT env var (Railway sets this)
	if (process.env.PORT && !process.env.CONDUCTOR_PORT) {
		const port = Number.parseInt(process.env.PORT, 10);
		if (!Number.isNaN(port)) {
			// Config is frozen, so create a new config with the port override
			config = {
				...config,
				server: { ...config.server, port },
			};
		}
	}

	const conductor = new Conductor(config);

	// Graceful shutdown
	const shutdown = async () => {
		console.log("\n[Conductor] Shutting down...");
		try {
			await conductor.stop();
		} catch (err) {
			console.error("[Conductor] Error during shutdown:", err);
		}
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	try {
		await conductor.start();
	} catch (err) {
		console.error(
			"[Conductor] Failed to start:",
			err instanceof Error ? err.message : String(err),
		);
		process.exit(1);
	}
}

// Auto-execute when run directly
if (import.meta.main) {
	main();
}
