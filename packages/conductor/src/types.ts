/**
 * Core types for Posse Conductor
 *
 * Defines the type system for the conductor gateway, agent registry,
 * task routing, and dashboard functionality.
 */

import type { z } from 'zod';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Conductor operational mode
 * - 'single': Local agent only, no distribution
 * - 'posse': Full distributed agent routing
 */
export type ConductorMode = 'single' | 'posse';

/**
 * CORS configuration options
 */
export interface CORSConfig {
	/** Allowed origins (default: ['*']) */
	origins: string[];
	/** Allow credentials (default: true) */
	credentials: boolean;
}

/**
 * Gateway HTTP server configuration
 */
export interface GatewayConfig {
	/** Port to bind (default: 7777) */
	port: number;
	/** Host to bind (default: '0.0.0.0') */
	host: string;
	/** CORS settings */
	cors: CORSConfig;
}

/**
 * Agent default settings
 */
export interface AgentDefaults {
	/** Default model for agent tasks (default: 'moonshotai/kimi-k2.5') */
	defaultModel: string;
	/** Health check poll interval in ms (default: 30000) */
	healthCheckInterval: number;
	/** Request timeout in ms (default: 120000) */
	timeout: number;
	/** Max retries for failed requests (default: 3) */
	maxRetries: number;
}

/**
 * Posse member configuration
 * Explicitly configured agents in posse mode
 */
export interface PosseMember {
	/** Unique name for the agent */
	name: string;
	/** HTTP endpoint URL */
	endpoint: string;
	/** Supported model identifiers */
	models: string[];
	/** Capabilities this agent provides */
	capabilities: string[];
	/** Load balancing weight (default: 1) */
	weight: number;
}

/**
 * Posse-specific configuration
 */
export interface PosseConfig {
	/** Meilisearch registry URL */
	registryUrl: string;
	/** Optional Meilisearch API key */
	registryApiKey?: string;
	/** Explicitly configured posse members */
	members: PosseMember[];
}

/**
 * Complete Conductor configuration
 */
export interface ConductorConfig {
	/** Operational mode */
	mode: ConductorMode;
	/** Gateway settings */
	gateway: GatewayConfig;
	/** Agent defaults */
	agent: AgentDefaults;
	/** Posse configuration (optional in single mode) */
	posse?: PosseConfig;
}

// ============================================================================
// Agent Registry Types
// ============================================================================

/**
 * Agent operational status
 */
export type AgentStatus = 'online' | 'offline' | 'busy' | 'error' | 'unknown';

/**
 * Agent record from Meilisearch posse-registry
 */
export interface AgentRecord {
	/** Unique agent identifier */
	id: string;
	/** Human-readable name */
	name: string;
	/** HTTP endpoint URL */
	endpoint: string;
	/** Supported model identifiers */
	models: string[];
	/** Agent capabilities */
	capabilities: string[];
	/** Current operational status */
	status: AgentStatus;
	/** Last seen timestamp (ISO 8601) */
	lastSeen: string;
	/** Agent version */
	version: string;
	/** Additional metadata */
	metadata: Record<string, unknown>;
}

/**
 * Agent health information
 */
export interface AgentHealth {
	/** Agent ID */
	agentId: string;
	/** Whether agent is responding */
	isHealthy: boolean;
	/** Response time in ms (null if unavailable) */
	responseTime: number | null;
	/** Last health check timestamp */
	lastCheck: string;
	/** Error message if unhealthy */
	error?: string;
}

/**
 * Aggregated agent statistics
 */
export interface AgentStats {
	/** Total registered agents */
	total: number;
	/** Currently online agents */
	online: number;
	/** Offline agents */
	offline: number;
	/** Agents currently processing tasks */
	busy: number;
	/** Agents in error state */
	error: number;
}

// ============================================================================
// Task Routing Types
// ============================================================================

/**
 * Routing strategies available
 */
export type RoutingStrategy =
	| 'single'
	| 'round-robin'
	| 'explicit'
	| 'model-based'
	| 'capability-based'
	| 'weighted'
	| 'health-aware';

/**
 * Chat message format (OpenAI-compatible)
 */
export interface ChatMessage {
	/** Message role */
	role: 'system' | 'user' | 'assistant' | 'tool';
	/** Message content */
	content: string;
	/** Optional name for tool/function messages */
	name?: string;
	/** Tool calls if applicable */
	tool_calls?: unknown[];
}

/**
 * Chat completion request
 */
export interface ChatRequest {
	/** Target model (optional, for model-based routing) */
	model?: string;
	/** Explicit agent selection (optional) */
	agent?: string;
	/** Messages for the conversation */
	messages: ChatMessage[];
	/** Required capabilities (optional) */
	capabilities?: string[];
	/** Whether to stream response */
	stream?: boolean;
	/** Temperature (0-2) */
	temperature?: number;
	/** Max tokens to generate */
	max_tokens?: number;
	/** Additional provider-specific options */
	[key: string]: unknown;
}

/**
 * Routing result
 */
export interface RouteResult {
	/** Selected agent record */
	agent: AgentRecord;
	/** Full endpoint URL */
	endpoint: string;
	/** Strategy used for routing */
	strategy: RoutingStrategy;
}

/**
 * Router interface
 */
export interface TaskRouter {
	/**
	 * Route a chat request to an appropriate agent
	 */
	route(request: ChatRequest): Promise<RouteResult>;
}

// ============================================================================
// Gateway Types
// ============================================================================

/**
 * Health check response
 */
export interface HealthResponse {
	/** Overall status */
	status: 'healthy' | 'degraded' | 'unhealthy';
	/** Operational mode */
	mode: ConductorMode;
	/** Agent statistics */
	agents: AgentStats;
	/** Conductor version */
	version: string;
	/** Response timestamp */
	timestamp: string;
}

/**
 * Posse command request
 */
export interface PosseCommand {
	/** Command to execute */
	command: 'restart' | 'pause' | 'resume' | 'status' | 'update' | string;
	/** Command target */
	target: 'all' | string;
	/** Optional command parameters */
	params?: Record<string, unknown>;
}

/**
 * Posse command response
 */
export interface PosseCommandResult {
	/** Command executed */
	command: string;
	/** Target agents */
	targets: string[];
	/** Results per agent */
	results: Array<{
		agent: string;
		success: boolean;
		message?: string;
		error?: string;
	}>;
	/** Overall success */
	success: boolean;
}

// ============================================================================
// Dashboard Types
// ============================================================================

/**
 * Task event types
 */
export type TaskEventType = 'started' | 'completed' | 'failed' | 'cancelled';

/**
 * Task event for dashboard
 */
export interface TaskEvent {
	/** Event ID */
	id: string;
	/** Event type */
	type: TaskEventType;
	/** Agent that handled the task */
	agentId: string;
	/** Optional task name/identifier */
	taskName?: string;
	/** Timestamp */
	timestamp: string;
	/** Duration in ms (if completed) */
	duration?: number;
	/** Error message (if failed) */
	error?: string;
}

/**
 * Dashboard statistics
 */
export interface DashboardStats {
	/** Total tasks processed */
	totalTasks: number;
	/** Currently active tasks */
	activeTasks: number;
	/** Failed tasks */
	failedTasks: number;
	/** Average response time in ms */
	avgResponseTime: number;
	/** Requests per minute */
	requestsPerMinute: number;
}

/**
 * Complete dashboard update
 */
export interface DashboardUpdate {
	/** All known agents */
	agents: AgentRecord[];
	/** Aggregated statistics */
	stats: DashboardStats;
	/** Recent task events */
	recentEvents: TaskEvent[];
	/** Last update timestamp */
	timestamp: string;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Registry event types
 */
export type RegistryEventType =
	| 'agent:online'
	| 'agent:offline'
	| 'agent:busy'
	| 'agent:idle'
	| 'agent:error'
	| 'agent:updated';

/**
 * Registry event payload
 */
export interface RegistryEvent {
	/** Event type */
	type: RegistryEventType;
	/** Affected agent */
	agent: AgentRecord;
	/** Previous status (if applicable) */
	previousStatus?: AgentStatus;
	/** Event timestamp */
	timestamp: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base conductor error
 */
export class ConductorError extends Error {
	readonly code: string;
	readonly statusCode: number;

	constructor(
		message: string,
		code: string,
		statusCode = 500
	) {
		super(message);
		this.name = 'ConductorError';
		this.code = code;
		this.statusCode = statusCode;
	}
}

/**
 * No agents available for routing
 */
export class NoAgentsAvailableError extends ConductorError {
	constructor(message = 'No agents available to handle request') {
		super(message, 'NO_AGENTS_AVAILABLE', 503);
		this.name = 'NoAgentsAvailableError';
	}
}

/**
 * Agent not found error
 */
export class AgentNotFoundError extends ConductorError {
	constructor(agentId: string) {
		super(`Agent not found: ${agentId}`, 'AGENT_NOT_FOUND', 404);
		this.name = 'AgentNotFoundError';
	}
}

/**
 * Invalid configuration error
 */
export class InvalidConfigError extends ConductorError {
	constructor(message: string) {
		super(message, 'INVALID_CONFIG', 400);
		this.name = 'InvalidConfigError';
	}
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Type helper for Zod schema inference
 */
export type InferZodSchema<T extends z.ZodType> = z.infer<T>;

/**
 * Nullable type helper
 */
export type Nullable<T> = T | null;

/**
 * Optional type helper for partial objects
 */
export type DeepPartial<T> = {
	[P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Event emitter interface for registry
 */
export interface RegistryEventEmitter {
	on(event: RegistryEventType, listener: (event: RegistryEvent) => void): void;
	off(event: RegistryEventType, listener: (event: RegistryEvent) => void): void;
	emit(event: RegistryEventType, payload: RegistryEvent): void;
}

/**
 * Conductor server interface
 */
export interface ConductorServer {
	/** Start the server */
	start(): Promise<void>;
	/** Stop the server */
	stop(): Promise<void>;
	/** Current configuration */
	readonly config: ConductorConfig;
	/** Agent registry instance */
	readonly registry: unknown;
}
