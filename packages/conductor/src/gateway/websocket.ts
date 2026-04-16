/**
 * WebSocket Gateway for Posse Conductor
 *
 * Socket.io-based WebSocket server providing real-time dashboard updates:
 * - Agent status changes
 * - Task progress events
 * - System status broadcasts
 * - Client subscription management
 */

import type { Server as HttpServer } from "node:http";
import { type Socket, Server as SocketIOServer } from "socket.io";
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
 * WebSocket gateway options
 */
export interface WebSocketGatewayOptions {
	/** CORS origins */
	corsOrigins?: string[];
	/** Enable debug logging */
	debug?: boolean;
}

// ============================================================================
// Dashboard WebSocket Class
// ============================================================================

export class DashboardWebSocket {
	private io: SocketIOServer;
	private registry: AgentRegistry;
	private options: WebSocketGatewayOptions;
	private activeTasks: Map<string, { startTime: number; agent: string }> = new Map();
	private totalTasks = 0;
	private debug: boolean;

	/**
	 * Create a new DashboardWebSocket gateway
	 */
	constructor(
		httpServer: HttpServer,
		registry: AgentRegistry,
		options: WebSocketGatewayOptions = {},
	) {
		this.registry = registry;
		this.options = options;
		this.debug = options.debug ?? false;

		this.io = new SocketIOServer(httpServer, {
			cors: {
				origin: options.corsOrigins ?? "*",
				methods: ["GET", "POST"],
				credentials: true,
			},
			transports: ["websocket", "polling"],
		});

		this.setupConnectionHandlers();
		this.setupRegistryListeners();

		if (this.debug) {
			console.log("[WebSocket] DashboardWebSocket initialized");
		}
	}

	// ============================================================================
	// Connection Handling
	// ============================================================================

	private setupConnectionHandlers(): void {
		this.io.on("connection", (socket: Socket) => {
			if (this.debug) {
				console.log(`[WebSocket] Client connected: ${socket.id}`);
			}

			// Send initial agent list
			socket.emit("agents:list", this.registry.getAllAgents());

			// Handle client events
			this.handleClientEvents(socket);

			// Handle disconnection
			socket.on("disconnect", () => {
				if (this.debug) {
					console.log(`[WebSocket] Client disconnected: ${socket.id}`);
				}
			});
		});
	}

	private handleClientEvents(socket: Socket): void {
		// Subscribe to agent updates
		socket.on("subscribe:agents", () => {
			if (this.debug) {
				console.log(`[WebSocket] Client ${socket.id} subscribed to agents`);
			}
			socket.emit("agents:list", this.registry.getAllAgents());
		});

		// Subscribe to task updates
		socket.on("subscribe:tasks", () => {
			if (this.debug) {
				console.log(`[WebSocket] Client ${socket.id} subscribed to tasks`);
			}
			// Client is now subscribed to task events
			socket.emit("tasks:subscribed", { success: true });
		});

		// Ping/pong for connection health
		socket.on("ping", () => {
			socket.emit("pong", { timestamp: new Date().toISOString() });
		});

		// Request system status
		socket.on("request:status", () => {
			socket.emit("system:status", this.getSystemStatus());
		});
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
	 * Broadcast agent update to all connected clients
	 */
	broadcastAgentUpdate(agent: AgentRecord): void {
		this.io.emit("agent:update", {
			agent,
			timestamp: new Date().toISOString(),
		});

		if (this.debug) {
			console.log(`[WebSocket] Broadcast agent:update for ${agent.name}`);
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

		this.io.emit("task:start", event);

		if (this.debug) {
			console.log(`[WebSocket] Broadcast task:start for task ${task.id} -> ${agent}`);
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

		this.io.emit("task:complete", { event, result });

		if (this.debug) {
			console.log(`[WebSocket] Broadcast task:complete for task ${result.taskId}`);
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

		this.io.emit("task:error", event);

		if (this.debug) {
			console.log(`[WebSocket] Broadcast task:error for task ${taskId}: ${error}`);
		}
	}

	/**
	 * Broadcast system status to all clients
	 */
	broadcastSystemStatus(status?: Partial<SystemStatus>): void {
		const fullStatus = this.getSystemStatus();
		const mergedStatus = { ...fullStatus, ...status };

		this.io.emit("system:status", mergedStatus);

		if (this.debug) {
			console.log("[WebSocket] Broadcast system:status");
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
			connectedClients: this.io.engine.clientsCount,
			activeTasks: this.activeTasks.size,
			totalTasks: this.totalTasks,
			timestamp: new Date().toISOString(),
		};
	}

	// ============================================================================
	// Utility Methods
	// ============================================================================

	/**
	 * Get the Socket.io server instance
	 */
	getIO(): SocketIOServer {
		return this.io;
	}

	/**
	 * Get count of connected clients
	 */
	getConnectedClientCount(): number {
		return this.io.engine.clientsCount;
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
	 * Close the WebSocket server
	 */
	async close(): Promise<void> {
		return new Promise((resolve) => {
			this.io.close(() => {
				if (this.debug) {
					console.log("[WebSocket] Server closed");
				}
				resolve();
			});
		});
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new DashboardWebSocket instance
 */
export function createWebSocketGateway(
	httpServer: HttpServer,
	registry: AgentRegistry,
	options?: WebSocketGatewayOptions,
): DashboardWebSocket {
	return new DashboardWebSocket(httpServer, registry, options);
}
