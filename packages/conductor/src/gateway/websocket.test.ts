/**
 * Tests for SSE Gateway (DashboardSSE)
 *
 * Tests the SSE-based dashboard event system that replaced Socket.io.
 *
 * @module gateway/websocket.test
 */

import { describe, expect, it } from "bun:test";
import type { AgentRegistry, EnrichedAgentRecord } from "../agents/registry.ts";
import { DashboardSSE, createDashboardSSE, createSSERouter } from "./websocket.ts";

// ============================================================================
// Mock Registry Type
// ============================================================================

interface MockAgentRegistry extends AgentRegistry {
	emit: (e: string, d: unknown) => void;
	addAgent: (a: EnrichedAgentRecord) => void;
	clear: () => void;
}

// ============================================================================
// Mock Registry Factory
// ============================================================================

function createMockRegistry(): MockAgentRegistry {
	const agents = new Map<string, EnrichedAgentRecord>();
	const listeners = new Map<string, Array<(event: unknown) => void>>();

	const registry = {
		getAllAgents: () => Array.from(agents.values()),
		getAgent: (name: string) => agents.get(name),
		getHealthyAgents: () => {
			const all = Array.from(agents.values());
			return all.filter(
				(a: EnrichedAgentRecord) => a.health.status === "healthy" || a.health.status === "busy",
			);
		},
		getStats: () => {
			const all = Array.from(agents.values());
			return {
				total: all.length,
				online: all.filter((a: EnrichedAgentRecord) => a.health.status === "healthy").length,
				offline: all.filter((a: EnrichedAgentRecord) => a.health.status === "offline").length,
				busy: all.filter((a: EnrichedAgentRecord) => a.health.status === "busy").length,
				error: all.filter((a: EnrichedAgentRecord) => a.health.status === "stale").length,
			};
		},
		getPosseName: () => "test-posse",
		isActive: true,
		startPolling: () => {},
		stopPolling: () => {},
		refresh: async () => {},
		getAgentsByRole: () => [],
		getAgentsByCapability: () => [],
		getAgentsByModel: () => [],
		on: (event: string, listener: (event: unknown) => void) => {
			const existing = listeners.get(event) ?? [];
			existing.push(listener);
			listeners.set(event, existing);
		},
		off: () => {},
		initialize: async () => {},
		emit: (event: string, data: unknown) => {
			const eventListeners = listeners.get(event) ?? [];
			for (const listener of eventListeners) {
				listener(data);
			}
		},
		addAgent: (agent: EnrichedAgentRecord) => {
			agents.set(agent.name, agent);
		},
		clear: () => agents.clear(),
	} as unknown as MockAgentRegistry;

	return registry;
}

// ============================================================================
// Test Helpers
// ============================================================================

function createMockAgent(
	name: string,
	status: "online" | "offline" | "busy" = "online",
): EnrichedAgentRecord {
	const now = new Date().toISOString();
	return {
		id: name,
		name,
		endpoint: `http://localhost:7600/${name}`,
		models: ["moonshotai/kimi-k2.5"],
		capabilities: ["chat", "code"],
		status,
		lastSeen: now,
		version: "0.1.0",
		metadata: { role: "product-engineering" },
		health: {
			status: status === "busy" ? "busy" : status === "offline" ? "offline" : "healthy",
			lastSeen: now,
			isResponsive: status !== "offline",
			msSinceLastHeartbeat: 1000,
		},
	};
}

function createMockTask(overrides: Partial<{ id: string; content: string }> = {}) {
	return {
		id: overrides.id ?? "task-1",
		content: overrides.content ?? "Test task content",
		channel: "test",
		userId: "user-1",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

function createMockTaskResult(
	overrides: Partial<{
		taskId: string;
		content: string;
		agent: string;
		success: boolean;
		duration: number;
	}> = {},
) {
	return {
		taskId: overrides.taskId ?? "task-1",
		content: overrides.content ?? "Task completed successfully",
		agent: overrides.agent ?? "agent-1",
		success: overrides.success ?? true,
		duration: overrides.duration ?? 1000,
		...overrides,
	};
}

// ============================================================================
// Test Suite
// ============================================================================

describe("DashboardSSE", () => {
	describe("initialization", () => {
		it("should create a DashboardSSE instance", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			expect(gateway).toBeInstanceOf(DashboardSSE);
		});

		it("should have a Hono app", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			expect(gateway.app).toBeDefined();
		});

		it("should track connected clients (starts at 0)", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			expect(gateway.getConnectedClientCount()).toBe(0);
		});
	});

	describe("event broadcasting", () => {
		it("should broadcast agent:update event", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const agent = createMockAgent("agent-1");
			// Should not throw
			expect(() => gateway.broadcastAgentUpdate(agent)).not.toThrow();
		});

		it("should broadcast task:start event", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const task = createMockTask({ id: "task-123" });
			expect(() => gateway.broadcastTaskStart(task, "agent-1")).not.toThrow();
			expect(gateway.getActiveTasksCount()).toBe(1);
		});

		it("should broadcast task:complete event", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const task = createMockTask({ id: "task-123" });
			gateway.broadcastTaskStart(task, "agent-1");

			const result = createMockTaskResult({ taskId: "task-123" });
			expect(() => gateway.broadcastTaskComplete(result)).not.toThrow();
			expect(gateway.getActiveTasksCount()).toBe(0);
		});

		it("should broadcast task:error event", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const task = createMockTask({ id: "task-123" });
			gateway.broadcastTaskStart(task, "agent-1");

			expect(() => gateway.broadcastTaskError("task-123", "Something went wrong")).not.toThrow();
			expect(gateway.getActiveTasksCount()).toBe(0);
		});

		it("should broadcast system:status event", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			expect(() => gateway.broadcastSystemStatus()).not.toThrow();
		});

		it("should broadcast with custom status", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const customStatus = { status: "degraded" as const };
			expect(() => gateway.broadcastSystemStatus(customStatus)).not.toThrow();
		});
	});

	describe("registry integration", () => {
		it("should listen to registry events", () => {
			const mockRegistry = createMockRegistry();
			const _gateway = new DashboardSSE(mockRegistry);
			const agent = createMockAgent("agent-1");

			// Emit registry event - should not throw
			expect(() =>
				mockRegistry.emit("agent:online", {
					type: "agent:online",
					agent,
					timestamp: new Date().toISOString(),
				}),
			).not.toThrow();
		});

		it("should broadcast agent:offline events", () => {
			const mockRegistry = createMockRegistry();
			const _gateway = new DashboardSSE(mockRegistry);
			const agent = createMockAgent("agent-1", "offline");

			expect(() =>
				mockRegistry.emit("agent:offline", {
					type: "agent:offline",
					agent,
					timestamp: new Date().toISOString(),
				}),
			).not.toThrow();
		});

		it("should broadcast agent:busy events", () => {
			const mockRegistry = createMockRegistry();
			const _gateway = new DashboardSSE(mockRegistry);
			const agent = createMockAgent("agent-1", "busy");

			expect(() =>
				mockRegistry.emit("agent:busy", {
					type: "agent:busy",
					agent,
					timestamp: new Date().toISOString(),
				}),
			).not.toThrow();
		});

		it("should broadcast agent:idle events", () => {
			const mockRegistry = createMockRegistry();
			const _gateway = new DashboardSSE(mockRegistry);
			const agent = createMockAgent("agent-1", "online");

			expect(() =>
				mockRegistry.emit("agent:idle", {
					type: "agent:idle",
					agent,
					timestamp: new Date().toISOString(),
				}),
			).not.toThrow();
		});

		it("should broadcast agent:updated events", () => {
			const mockRegistry = createMockRegistry();
			const _gateway = new DashboardSSE(mockRegistry);
			const agent = createMockAgent("agent-1");

			expect(() =>
				mockRegistry.emit("agent:updated", {
					type: "agent:updated",
					agent,
					timestamp: new Date().toISOString(),
				}),
			).not.toThrow();
		});
	});

	describe("task tracking", () => {
		it("should track active tasks", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const task = createMockTask({ id: "task-1" });
			expect(gateway.getActiveTasksCount()).toBe(0);

			gateway.broadcastTaskStart(task, "agent-1");
			expect(gateway.getActiveTasksCount()).toBe(1);

			gateway.broadcastTaskComplete(createMockTaskResult({ taskId: "task-1" }));
			expect(gateway.getActiveTasksCount()).toBe(0);
		});

		it("should track total tasks", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			expect(gateway.getTotalTasks()).toBe(0);

			gateway.broadcastTaskStart(createMockTask({ id: "task-1" }), "agent-1");
			expect(gateway.getTotalTasks()).toBe(1);

			gateway.broadcastTaskStart(createMockTask({ id: "task-2" }), "agent-1");
			expect(gateway.getTotalTasks()).toBe(2);
		});

		it("should calculate task duration on complete", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const task = createMockTask({ id: "task-123" });
			gateway.broadcastTaskStart(task, "agent-1");

			const result = createMockTaskResult({ taskId: "task-123", duration: 100 });
			gateway.broadcastTaskComplete(result);
			expect(gateway.getActiveTasksCount()).toBe(0);
		});
	});

	describe("error handling", () => {
		it("should handle tasks that fail", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);

			// Start a task
			gateway.broadcastTaskStart(createMockTask({ id: "task-fail" }), "agent-1");

			// Fail it
			gateway.broadcastTaskError("task-fail", "Task execution failed");

			expect(gateway.getActiveTasksCount()).toBe(0);
		});

		it("should handle tasks without agent info on error", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);

			// Error a task that was never started
			expect(() => gateway.broadcastTaskError("never-started", "Error")).not.toThrow();
		});
	});

	describe("getters", () => {
		it("should return connected client count", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const count = gateway.getConnectedClientCount();
			expect(typeof count).toBe("number");
			expect(count).toBeGreaterThanOrEqual(0);
		});

		it("should return active tasks count", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const count = gateway.getActiveTasksCount();
			expect(typeof count).toBe("number");
			expect(count).toBeGreaterThanOrEqual(0);
		});

		it("should return total tasks", () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			const count = gateway.getTotalTasks();
			expect(typeof count).toBe("number");
			expect(count).toBeGreaterThanOrEqual(0);
		});
	});

	describe("SSE endpoint", () => {
		it("should have /events endpoint that returns SSE content-type", async () => {
			const mockRegistry = createMockRegistry();
			mockRegistry.addAgent(createMockAgent("agent-1"));
			const gateway = new DashboardSSE(mockRegistry);

			const response = await gateway.app.request("/events");
			expect(response.status).toBe(200);
			const contentType = response.headers.get("content-type");
			expect(contentType).toContain("text/event-stream");
		});
	});

	describe("factory functions", () => {
		it("createDashboardSSE should create a DashboardSSE", () => {
			const mockRegistry = createMockRegistry();
			const gateway = createDashboardSSE(mockRegistry);
			expect(gateway).toBeInstanceOf(DashboardSSE);
		});

		it("createSSERouter should return a Hono app", async () => {
			const mockRegistry = createMockRegistry();
			const app = createSSERouter(mockRegistry);
			expect(app).toBeDefined();
		});

		it("createSSERouter without registry should return 503", async () => {
			const app = createSSERouter();
			const response = await app.request("/events");
			expect(response.status).toBe(503);
		});
	});

	describe("close", () => {
		it("should close cleanly", async () => {
			const mockRegistry = createMockRegistry();
			const gateway = new DashboardSSE(mockRegistry);
			await expect(gateway.close()).resolves.toBeUndefined();
		});
	});
});
