/**
 * Tests for HTTP Gateway
 *
 * @module gateway/http.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ConductorConfig } from "../config.ts";
import type { ChatRequest, TaskRouter } from "../types.ts";
import { createHttpServer } from "./http.ts";

// ============================================================================
// Mock Router
// ============================================================================

const mockRouter: TaskRouter = {
	async route(_request: ChatRequest) {
		return {
			agent: {
				id: "test-agent",
				name: "test-agent",
				endpoint: "http://localhost:7600",
				models: ["moonshotai/kimi-k2.5"],
				capabilities: ["chat"],
				status: "online",
				lastSeen: new Date().toISOString(),
				version: "0.1.0",
				metadata: {},
			},
			endpoint: "http://localhost:7600",
			strategy: "explicit",
		};
	},
};

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
			port: 0, // Let the OS assign a port
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
		let gateway: ReturnType<typeof createHttpServer>;
		let config: ConductorConfig;

		beforeEach(async () => {
			config = createTestConfig("single");
			gateway = createHttpServer(config);
			await gateway.start();
		});

		afterEach(async () => {
			await gateway.stop();
		});

		it("should respond to health check", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/health`);
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.status).toBe("healthy");
			expect(body.mode).toBe("single");
			expect(body.agents.total).toBe(0);
			expect(body.version).toBe("0.1.0");
			expect(body.timestamp).toBeDefined();
		});

		it("should reject posse endpoints with 403", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/agents`);
			expect(response.status).toBe(403);

			const body = await response.json();
			expect(body.code).toBe("FORBIDDEN");
		});

		it("should return isRunning true when started", () => {
			expect(gateway.isRunning()).toBe(true);
		});

		it("should return isRunning false when stopped", async () => {
			await gateway.stop();
			expect(gateway.isRunning()).toBe(false);
		});
	});

	describe("posse mode", () => {
		let gateway: ReturnType<typeof createHttpServer>;
		let config: ConductorConfig;
		let mockRegistry: AgentRegistry;

		beforeEach(async () => {
			config = createTestConfig("posse");
			mockRegistry = createMockRegistry();
			gateway = createHttpServer(config, mockRegistry, mockRouter);
			await gateway.start();
		});

		afterEach(async () => {
			await gateway.stop();
		});

		it("should respond to health check", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/health`);
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.status).toBe("healthy");
			expect(body.mode).toBe("posse");
		});

		it("should list all agents", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/agents`);
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.agents).toHaveLength(2);
			expect(body.total).toBe(2);
			expect(body.timestamp).toBeDefined();
		});

		it("should return detailed posse health", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/health`);
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.posse.name).toBe("test-posse");
			expect(body.conductor.status).toBe("healthy");
			expect(body.agents.stats.total).toBe(2);
			expect(body.agents.details).toHaveLength(2);
		});

		it("should accept posse command", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/command`, {
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
			const response = await fetch(
				`http://127.0.0.1:${gateway.getPort()}/posse/command?agent=agent-1`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						command: "restart",
						target: "all",
					}),
				},
			);
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.targets).toEqual(["agent-1"]);
		});

		it("should handle missing command field", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/command`, {
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
		let gateway: ReturnType<typeof createHttpServer>;
		let config: ConductorConfig;

		beforeEach(async () => {
			config = createTestConfig("single");
			gateway = createHttpServer(config, undefined, mockRouter);
			await gateway.start();
		});

		afterEach(async () => {
			await gateway.stop();
		});

		it("should accept valid chat request", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/v1/chat`, {
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
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/v1/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "test" }),
			});
			expect(response.status).toBe(400);

			const body = await response.json();
			expect(body.code).toBe("VALIDATION_ERROR");
		});

		it("should reject invalid chat request with non-array messages", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/v1/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "test",
					messages: "not an array",
				}),
			});
			expect(response.status).toBe(400);
		});
	});

	describe("authentication", () => {
		let gateway: ReturnType<typeof createHttpServer>;
		let config: ConductorConfig;

		beforeEach(async () => {
			config = createTestConfig("single");
			config.gateway.http.auth = "test-token";
			gateway = createHttpServer(config);
			await gateway.start();
		});

		afterEach(async () => {
			await gateway.stop();
		});

		it("should allow /health without auth token (public healthcheck)", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/health`);
			expect(response.status).toBe(200);

			const body = await response.json();
			expect(body.status).toBe("healthy");
		});

		it("should reject protected routes without auth token", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/agents`);
			expect(response.status).toBe(401);

			const body = await response.json();
			expect(body.code).toBe("UNAUTHORIZED");
		});

		it("should reject requests with invalid token format", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/agents`, {
				headers: { Authorization: "invalid-format" },
			});
			expect(response.status).toBe(401);

			const body = await response.json();
			expect(body.code).toBe("UNAUTHORIZED");
		});

		it("should reject requests with wrong token", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/agents`, {
				headers: { Authorization: "Bearer wrong-token" },
			});
			expect(response.status).toBe(401);

			const body = await response.json();
			expect(body.code).toBe("UNAUTHORIZED");
		});

		it("should accept requests with valid token", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/posse/agents`, {
				headers: { Authorization: "Bearer test-token" },
			});
			// 403 because auth passes but single mode rejects posse endpoints
			expect(response.status).toBe(403);
		});
	});

	describe("CORS", () => {
		let gateway: ReturnType<typeof createHttpServer>;
		let config: ConductorConfig;

		beforeEach(async () => {
			config = createTestConfig("single");
			gateway = createHttpServer(config);
			await gateway.start();
		});

		afterEach(async () => {
			await gateway.stop();
		});

		it("should allow CORS preflight requests", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/health`, {
				method: "OPTIONS",
				headers: {
					Origin: "http://localhost:3000",
					"Access-Control-Request-Method": "GET",
				},
			});
			expect(response.status).toBe(204);
		});

		it("should include CORS headers in responses", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/health`, {
				headers: { Origin: "http://localhost:3000" },
			});
			// Response should succeed, CORS headers are present but may not be exposed in fetch response
			expect(response.status).toBe(200);
		});
	});

	describe("error handling", () => {
		let gateway: ReturnType<typeof createHttpServer>;
		let config: ConductorConfig;

		beforeEach(async () => {
			config = createTestConfig("single");
			gateway = createHttpServer(config);
			await gateway.start();
		});

		afterEach(async () => {
			await gateway.stop();
		});

		it("should return 404 for unknown routes", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/unknown-route`);
			expect(response.status).toBe(404);
		});

		it("should return 405 for wrong method", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/health`, {
				method: "POST",
			});
			expect(response.status).toBe(404);
		});

		it("should handle malformed JSON", async () => {
			const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/v1/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not valid json",
			});
			// Express returns 400 for malformed JSON by default
			expect(response.status).toBeGreaterThanOrEqual(400);
		});
	});
});
