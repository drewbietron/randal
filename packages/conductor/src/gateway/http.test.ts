/**
 * Tests for HTTP Gateway
 *
 * Uses Hono's built-in app.request() for testing without a real server.
 *
 * @module gateway/http.test
 */

import { describe, expect, it } from "bun:test";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ConductorConfig } from "../config.ts";
import type { TaskRouter } from "../router/index.ts";
import { createHttpServer } from "./http.ts";

// ============================================================================
// Mock Router
// ============================================================================

const mockRouter = {
	async routeTask(_task: {
		id: string;
		content: string;
		channel: string;
		userId: string;
		timestamp: string;
	}) {
		return {
			taskId: _task.id,
			content: "Hello! I'm a test agent.",
			agent: "test-agent",
			success: true,
			duration: 42,
		};
	},
} as unknown as TaskRouter;

// ============================================================================
// Mock Registry
// ============================================================================

function createMockRegistry(): AgentRegistry {
	return {
		getAllAgents: () => [
			{
				id: "agent-1",
				name: "agent-1",
				endpoint: "http://localhost:7601",
				models: ["model-a"],
				capabilities: ["chat"],
				status: "online",
				lastSeen: new Date().toISOString(),
				version: "0.1.0",
				metadata: {},
				health: {
					status: "healthy",
					lastSeen: new Date().toISOString(),
					isResponsive: true,
					msSinceLastHeartbeat: 1000,
				},
			},
			{
				id: "agent-2",
				name: "agent-2",
				endpoint: "http://localhost:7602",
				models: ["model-b"],
				capabilities: ["code"],
				status: "busy",
				lastSeen: new Date().toISOString(),
				version: "0.1.0",
				metadata: {},
				health: {
					status: "busy",
					lastSeen: new Date().toISOString(),
					isResponsive: true,
					msSinceLastHeartbeat: 1000,
				},
			},
		],
		getAgent: (name: string) => {
			if (name === "agent-1") {
				return {
					id: "agent-1",
					name: "agent-1",
					endpoint: "http://localhost:7601",
					models: ["model-a"],
					capabilities: ["chat"],
					status: "online",
					lastSeen: new Date().toISOString(),
					version: "0.1.0",
					metadata: {},
					health: {
						status: "healthy",
						lastSeen: new Date().toISOString(),
						isResponsive: true,
						msSinceLastHeartbeat: 1000,
					},
				};
			}
			return undefined;
		},
		getHealthyAgents: () => [
			{
				id: "agent-1",
				name: "agent-1",
				endpoint: "http://localhost:7601",
				models: ["model-a"],
				capabilities: ["chat"],
				status: "online",
				lastSeen: new Date().toISOString(),
				version: "0.1.0",
				metadata: {},
				health: {
					status: "healthy",
					lastSeen: new Date().toISOString(),
					isResponsive: true,
					msSinceLastHeartbeat: 1000,
				},
			},
		],
		getStats: () => ({
			total: 2,
			online: 1,
			offline: 0,
			busy: 1,
			error: 0,
		}),
		getPosseName: () => "test-posse",
		isActive: true,
		lastPoll: new Date(),
		startPolling: () => {},
		stopPolling: () => {},
		refresh: async () => {},
		getAgentsByRole: () => [],
		getAgentsByCapability: () => [],
		getAgentsByModel: () => [],
		on: () => {},
		off: () => {},
		initialize: async () => {},
	} as unknown as AgentRegistry;
}

// ============================================================================
// Test Helpers
// ============================================================================

function createTestConfig(mode: "single" | "posse" = "posse"): ConductorConfig {
	return {
		mode,
		model: "moonshotai/kimi-k2.5",
		server: {
			port: 0,
			host: "127.0.0.1",
		},
		gateway: {
			http: {
				enabled: true,
				auth: undefined,
			},
			discord: {
				enabled: false,
			},
		},
		routing: {
			strategy: "auto",
		},
		...(mode === "single"
			? {
					agent: {
						name: "local-agent",
						url: "http://localhost:7600",
						model: "moonshotai/kimi-k2.5",
					},
				}
			: {
					posse: {
						name: "test-posse",
						meilisearch: {
							url: "http://localhost:7700",
							apiKey: "",
						},
						discovery: {
							enabled: true,
							pollInterval: 30000,
						},
					},
				}),
	} as ConductorConfig;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("HttpGateway", () => {
	describe("single mode", () => {
		it("should respond to health check", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/health");
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.status).toBe("healthy");
			expect(body.mode).toBe("single");
			expect(body.agents.total).toBe(0);
			expect(body.version).toBe("0.1.0");
			expect(body.timestamp).toBeDefined();
		});

		it("should reject posse endpoints with 403", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/posse/agents");
			expect(response.status).toBe(403);

			const body = await response.json();
			expect(body.code).toBe("FORBIDDEN");
		});

		it("should return isRunning true when started", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			await gateway.start();
			expect(gateway.isRunning()).toBe(true);
			await gateway.stop();
		});

		it("should return isRunning false when stopped", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			await gateway.start();
			await gateway.stop();
			expect(gateway.isRunning()).toBe(false);
		});
	});

	describe("posse mode", () => {
		it("should respond to health check", async () => {
			const config = createTestConfig("posse");
			const mockRegistry = createMockRegistry();
			const gateway = createHttpServer(config, mockRegistry, mockRouter);
			const app = gateway.app;

			const response = await app.request("/health");
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.status).toBe("healthy");
			expect(body.mode).toBe("posse");
		});

		it("should list all agents", async () => {
			const config = createTestConfig("posse");
			const mockRegistry = createMockRegistry();
			const gateway = createHttpServer(config, mockRegistry, mockRouter);
			const app = gateway.app;

			const response = await app.request("/posse/agents");
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.agents).toHaveLength(2);
			expect(body.total).toBe(2);
			expect(body.timestamp).toBeDefined();
		});

		it("should return detailed posse health", async () => {
			const config = createTestConfig("posse");
			const mockRegistry = createMockRegistry();
			const gateway = createHttpServer(config, mockRegistry, mockRouter);
			const app = gateway.app;

			const response = await app.request("/posse/health");
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.posse.name).toBe("test-posse");
			expect(body.conductor.status).toBe("healthy");
			expect(body.agents.stats.total).toBe(2);
			expect(body.agents.details).toHaveLength(2);
		});

		it("should accept posse command", async () => {
			const config = createTestConfig("posse");
			const mockRegistry = createMockRegistry();
			const gateway = createHttpServer(config, mockRegistry, mockRouter);
			const app = gateway.app;

			const response = await app.request("/posse/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "status",
					target: "all",
				}),
			});
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.command).toBe("status");
			expect(body.targets).toContain("agent-1");
			expect(body.targets).toContain("agent-2");
			expect(body.success).toBe(false); // One agent not found
		});

		it("should accept posse command with specific agent", async () => {
			const config = createTestConfig("posse");
			const mockRegistry = createMockRegistry();
			const gateway = createHttpServer(config, mockRegistry, mockRouter);
			const app = gateway.app;

			const response = await app.request("/posse/command?agent=agent-1", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					command: "restart",
					target: "all",
				}),
			});
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.targets).toEqual(["agent-1"]);
		});

		it("should handle missing command field", async () => {
			const config = createTestConfig("posse");
			const mockRegistry = createMockRegistry();
			const gateway = createHttpServer(config, mockRegistry, mockRouter);
			const app = gateway.app;

			const response = await app.request("/posse/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target: "all" }),
			});
			expect(response.status).toBe(400);

			const body = await response.json();
			expect(body.code).toBe("VALIDATION_ERROR");
		});
	});

	describe("chat endpoint", () => {
		it("should accept valid chat request", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config, undefined, mockRouter);
			const app = gateway.app;

			const response = await app.request("/v1/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "moonshotai/kimi-k2.5",
					messages: [{ role: "user", content: "Hello" }],
				}),
			});
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.id).toBeDefined();
			expect(body.status).toBe("completed");
			expect(body.timestamp).toBeDefined();
		});

		it("should reject invalid chat request without messages", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config, undefined, mockRouter);
			const app = gateway.app;

			const response = await app.request("/v1/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "test" }),
			});
			expect(response.status).toBe(400);

			const body = await response.json();
			expect(body.code).toBe("VALIDATION_ERROR");
		});

		it("should reject invalid chat request with non-array messages", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config, undefined, mockRouter);
			const app = gateway.app;

			const response = await app.request("/v1/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "test",
					messages: "not an array",
				}),
			});
			expect(response.status).toBe(400);
		});

		it("should return 503 when no router configured", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/v1/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "test",
					messages: [{ role: "user", content: "Hello" }],
				}),
			});
			expect(response.status).toBe(503);
		});
	});

	describe("authentication", () => {
		it("should allow /health without auth token (public healthcheck)", async () => {
			const config = createTestConfig("single");
			(config as Record<string, unknown>).gateway = {
				...config.gateway,
				http: { ...config.gateway.http, auth: "test-token" },
			};
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/health");
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.status).toBe("healthy");
		});

		it("should reject protected routes without auth token", async () => {
			const config = createTestConfig("single");
			(config as Record<string, unknown>).gateway = {
				...config.gateway,
				http: { ...config.gateway.http, auth: "test-token" },
			};
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/posse/agents");
			expect(response.status).toBe(401);

			const body = await response.json();
			expect(body.code).toBe("UNAUTHORIZED");
		});

		it("should reject requests with invalid token format", async () => {
			const config = createTestConfig("single");
			(config as Record<string, unknown>).gateway = {
				...config.gateway,
				http: { ...config.gateway.http, auth: "test-token" },
			};
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/posse/agents", {
				headers: { Authorization: "invalid-format" },
			});
			expect(response.status).toBe(401);

			const body = await response.json();
			expect(body.code).toBe("UNAUTHORIZED");
		});

		it("should reject requests with wrong token", async () => {
			const config = createTestConfig("single");
			(config as Record<string, unknown>).gateway = {
				...config.gateway,
				http: { ...config.gateway.http, auth: "test-token" },
			};
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/posse/agents", {
				headers: { Authorization: "Bearer wrong-token" },
			});
			expect(response.status).toBe(401);

			const body = await response.json();
			expect(body.code).toBe("UNAUTHORIZED");
		});

		it("should accept requests with valid token", async () => {
			const config = createTestConfig("single");
			(config as Record<string, unknown>).gateway = {
				...config.gateway,
				http: { ...config.gateway.http, auth: "test-token" },
			};
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/posse/agents", {
				headers: { Authorization: "Bearer test-token" },
			});
			// 403 because auth passes but single mode rejects posse endpoints
			expect(response.status).toBe(403);
		});
	});

	describe("CORS", () => {
		it("should allow CORS preflight requests", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/health", {
				method: "OPTIONS",
				headers: {
					Origin: "http://localhost:3000",
					"Access-Control-Request-Method": "GET",
				},
			});
			expect(response.status).toBe(204);
		});

		it("should include CORS headers in responses", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/health", {
				headers: { Origin: "http://localhost:3000" },
			});
			expect(response.status).toBe(200);
		});
	});

	describe("error handling", () => {
		it("should return 404 for unknown routes", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/unknown-route");
			expect(response.status).toBe(404);
		});

		it("should return 404 for wrong method", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			const app = gateway.app;

			const response = await app.request("/health", {
				method: "POST",
			});
			expect(response.status).toBe(404);
		});

		it("should handle malformed JSON", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config, undefined, mockRouter);
			const app = gateway.app;

			const response = await app.request("/v1/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not valid json",
			});
			expect(response.status).toBeGreaterThanOrEqual(400);
		});
	});

	describe("server lifecycle", () => {
		it("should expose getServer() returning null before start", () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			expect(gateway.getServer()).toBeNull();
		});

		it("should expose getServer() returning server after start", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			await gateway.start();
			expect(gateway.getServer()).not.toBeNull();
			await gateway.stop();
		});

		it("should return getServer() as null after stop", async () => {
			const config = createTestConfig("single");
			const gateway = createHttpServer(config);
			await gateway.start();
			await gateway.stop();
			expect(gateway.getServer()).toBeNull();
		});
	});
});
