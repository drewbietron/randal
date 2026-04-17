/**
 * SSE Gateway for Posse Conductor
 *
 * Hono SSE-based event stream providing real-time dashboard updates:
 * - Agent status changes
 * - Task progress events
 * - System status broadcasts
 *
 * Replaces the previous Socket.io WebSocket implementation.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentRegistry } from "../agents/registry.ts";
import type { AgentRecord, RegistryEvent, RegistryEventType, TaskEvent } from "../types.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Task definition for routing
 */
export interface Task {
	/** Unique task identifier */
	id: string;
	/** Task content/instruction */
	content: string;
	/** Channel this task came from */
	channel: string;
	/** User identifier */
	userId: string;
	/** Task creation timestamp */
	timestamp: string;
	/** Explicitly specified agent (optional) */
	explicitAgent?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Task routing result
 */
export interface TaskResult {
	/** Task ID */
	taskId: string;
	/** Response content */
	content: string;
	/** Agent that handled the task */
	agent: string;
	/** Whether the task succeeded */
	success: boolean;
	/** Duration in ms */
	duration: number;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Task analysis result for auto-routing
 */
export interface TaskIntent {
	/** Detected task type */
	type: string;
	/** Estimated complexity (1-10) */
	complexity: number;
	/** Suggested agent names */
	suggestedAgents: string[];
}

/**
 * System status information
 */
export interface SystemStatus {
	/** Overall system state */
	status: "healthy" | "degraded" | "unhealthy";
	/** Connected client count */
	connectedClients: number;
	/** Active tasks count */
	activeTasks: number;
	/** Total tasks processed */
	totalTasks: number;
	/** Timestamp */
	timestamp: string;
}

/**
 * SSE gateway options
 */
export interface SSEGatewayOptions {
	/** Enable debug logging */
	debug?: boolean;
	/** Keepalive interval in ms (default: 15000) */
	keepaliveInterval?: number;
}

/**
 * SSE event payload shape
 */
interface SSEEventPayload {
	event: string;
	data: unknown;
}

// ============================================================================
// Dashboard SSE Class
// ============================================================================

export class DashboardSSE {
	private registry: AgentRegistry;
	private options: SSEGatewayOptions;
	private activeTasks: Map<string, { startTime: number; agent: string }> = new Map();
	private totalTasks = 0;
	private debug: boolean;
	private connectedClients = 0;
	private eventListeners: Set<(payload: SSEEventPayload) => void> = new Set();
	readonly app: Hono;

	/**
	 * Create a new DashboardSSE gateway
	 */
	constructor(registry: AgentRegistry, options: SSEGatewayOptions = {}) {
		this.registry = registry;
		this.options = options;
		this.debug = options.debug ?? false;

		this.app = this.createApp();
		this.setupRegistryListeners();

		if (this.debug) {
			console.log("[SSE] DashboardSSE initialized");
		}
	}

	// ============================================================================
	// Hono App Setup
	// ============================================================================

	private createApp(): Hono {
		const app = new Hono();

		app.get("/events", (c) => {
			return streamSSE(c, async (stream) => {
				this.connectedClients++;

				if (this.debug) {
					console.log(`[SSE] Client connected (total: ${this.connectedClients})`);
				}

				// Send initial agent list
				await stream.writeSSE({
					event: "agents:list",
					data: JSON.stringify(this.registry.getAllAgents()),
				});

				// Subscribe to events
				const listener = async (payload: SSEEventPayload) => {
					try {
						await stream.writeSSE({
							event: payload.event,
							data: JSON.stringify(payload.data),
						});
					} catch {
						// Stream may be closed, ignore write errors
					}
				};

				this.eventListeners.add(listener);

				// Keepalive ping
				const keepaliveMs = this.options.keepaliveInterval ?? 15000;
				const keepalive = setInterval(async () => {
					try {
						await stream.writeSSE({
							event: "ping",
							data: JSON.stringify({ timestamp: new Date().toISOString() }),
						});
					} catch {
						// Stream closed
						clearInterval(keepalive);
					}
				}, keepaliveMs);

				// Cleanup on disconnect
				stream.onAbort(() => {
					this.connectedClients--;
					this.eventListeners.delete(listener);
					clearInterval(keepalive);

					if (this.debug) {
						console.log(`[SSE] Client disconnected (total: ${this.connectedClients})`);
					}
				});

				// Block to keep the stream open
				await new Promise(() => {});
			});
		});

		return app;
	}

	// ============================================================================
	// Registry Event Integration
	// ============================================================================

	private setupRegistryListeners(): void {
		const eventTypes: RegistryEventType[] = [
			"agent:online",
			"agent:offline",
			"agent:busy",
			"agent:idle",
			"agent:error",
			"agent:updated",
		];

		for (const eventType of eventTypes) {
			this.registry.on(eventType, (event: RegistryEvent) => {
				this.broadcastAgentUpdate(event.agent);
			});
		}
	}

	// ============================================================================
	// Event Broadcasting
	// ============================================================================

	/**
	 * Push an event to all connected SSE clients
	 */
	private pushEvent(event: string, data: unknown): void {
		for (const listener of this.eventListeners) {
			listener({ event, data });
		}
	}

	/**
	 * Broadcast agent update to all connected clients
	 */
	broadcastAgentUpdate(agent: AgentRecord): void {
		this.pushEvent("agent:update", {
			agent,
			timestamp: new Date().toISOString(),
		});

		if (this.debug) {
			console.log(`[SSE] Broadcast agent:update for ${agent.name}`);
		}
	}

	/**
	 * Broadcast task start event
	 */
	broadcastTaskStart(task: Task, agent: string): void {
		this.activeTasks.set(task.id, { startTime: Date.now(), agent });
		this.totalTasks++;

		const event: TaskEvent = {
			id: task.id,
			type: "started",
			agentId: agent,
			taskName: task.content.slice(0, 100),
			timestamp: new Date().toISOString(),
		};

		this.pushEvent("task:start", event);

		if (this.debug) {
			console.log(`[SSE] Broadcast task:start for task ${task.id} -> ${agent}`);
		}
	}

	/**
	 * Broadcast task completion event
	 */
	broadcastTaskComplete(result: TaskResult): void {
		this.activeTasks.delete(result.taskId);

		const event: TaskEvent = {
			id: result.taskId,
			type: "completed",
			agentId: result.agent,
			timestamp: new Date().toISOString(),
			duration: result.duration,
		};

		this.pushEvent("task:complete", { event, result });

		if (this.debug) {
			console.log(`[SSE] Broadcast task:complete for task ${result.taskId}`);
		}
	}

	/**
	 * Broadcast task error event
	 */
	broadcastTaskError(taskId: string, error: string, agent?: string): void {
		const activeTask = this.activeTasks.get(taskId);
		this.activeTasks.delete(taskId);

		const event: TaskEvent = {
			id: taskId,
			type: "failed",
			agentId: agent ?? activeTask?.agent ?? "unknown",
			timestamp: new Date().toISOString(),
			duration: activeTask ? Date.now() - activeTask.startTime : undefined,
			error,
		};

		this.pushEvent("task:error", event);

		if (this.debug) {
			console.log(`[SSE] Broadcast task:error for task ${taskId}: ${error}`);
		}
	}

	/**
	 * Broadcast system status to all clients
	 */
	broadcastSystemStatus(status?: Partial<SystemStatus>): void {
		const fullStatus = this.getSystemStatus();
		const mergedStatus = { ...fullStatus, ...status };

		this.pushEvent("system:status", mergedStatus);

		if (this.debug) {
			console.log("[SSE] Broadcast system:status");
		}
	}

	/**
	 * Get current system status
	 */
	private getSystemStatus(): SystemStatus {
		const stats = this.registry.getStats();
		let status: SystemStatus["status"] = "healthy";

		if (stats.online === 0 && stats.busy === 0) {
			status = "unhealthy";
		} else if (stats.offline > 0 || stats.error > 0) {
			status = "degraded";
		}

		return {
			status,
			connectedClients: this.connectedClients,
			activeTasks: this.activeTasks.size,
			totalTasks: this.totalTasks,
			timestamp: new Date().toISOString(),
		};
	}

	// ============================================================================
	// Utility Methods
	// ============================================================================

	/**
	 * Get count of connected clients
	 */
	getConnectedClientCount(): number {
		return this.connectedClients;
	}

	/**
	 * Get active tasks count
	 */
	getActiveTasksCount(): number {
		return this.activeTasks.size;
	}

	/**
	 * Get total tasks processed
	 */
	getTotalTasks(): number {
		return this.totalTasks;
	}

	/**
	 * Close the SSE gateway (cleanup)
	 */
	async close(): Promise<void> {
		this.eventListeners.clear();
		this.connectedClients = 0;

		if (this.debug) {
			console.log("[SSE] Gateway closed");
		}
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an SSE Hono router for dashboard events
 */
export function createSSERouter(registry?: AgentRegistry): Hono {
	if (!registry) {
		const app = new Hono();
		app.get("/events", (c) => {
			return c.json({ error: "Registry not available" }, 503);
		});
		return app;
	}

	const dashboard = new DashboardSSE(registry);
	return dashboard.app;
}

/**
 * Create a DashboardSSE instance (gives full access to broadcast methods)
 */
export function createDashboardSSE(
	registry: AgentRegistry,
	options?: SSEGatewayOptions,
): DashboardSSE {
	return new DashboardSSE(registry, options);
}
