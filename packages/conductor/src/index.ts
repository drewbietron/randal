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

// Export all types
export type {
	// Configuration
	ConductorMode,
	CORSConfig,
	GatewayConfig,
	AgentDefaults,
	PosseMember,
	PosseConfig,
	ConductorConfig,

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
	TaskRouter,

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
} from './types.js';

// Export errors
export {
	ConductorError,
	NoAgentsAvailableError,
	AgentNotFoundError,
	InvalidConfigError,
} from './types.js';

// Internal imports for implementation
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
} from './config.js';
export type { ConfigValidation } from './config.js';

import type { ConductorConfig, ConductorServer } from './types.js';

// Placeholder exports for future implementations
// These will be implemented in subsequent steps

/**
 * Load and validate configuration from file
 * @param _path - Path to YAML config file
 * @returns Validated configuration
 */

/**
 * Main Conductor class
 * Orchestrates the gateway, registry, and router
 */
export class Conductor implements ConductorServer {
	readonly config: ConductorConfig;
	readonly registry: unknown;

	constructor(config: ConductorConfig) {
		this.config = config;
		this.registry = null;
	}

	async start(): Promise<void> {
		// Steps 3-6 will implement this
		throw new Error('Conductor server not yet implemented. See Steps 3-6.');
	}

	async stop(): Promise<void> {
		// Steps 3-6 will implement this
		throw new Error('Conductor server not yet implemented. See Steps 3-6.');
	}
}

/**
 * Version of the conductor package
 */
export const VERSION = '0.1.0';

/**
 * Default configuration values
 */
export const DEFAULTS = {
	port: 7777,
	host: '0.0.0.0',
	mode: 'single' as const,
	defaultModel: 'moonshotai/kimi-k2.5',
	healthCheckInterval: 30000,
	timeout: 120000,
	maxRetries: 3,
};
