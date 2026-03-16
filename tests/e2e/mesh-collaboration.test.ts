import { describe, expect, test } from "bun:test";
import type { MeshInstance } from "@randal/core";
import { MemoryMeshRegistry, routeTask } from "@randal/mesh";

function makeInstance(overrides: Partial<MeshInstance> = {}): MeshInstance {
	return {
		instanceId: `inst-${Math.random().toString(36).slice(2, 10)}`,
		name: "test-instance",
		posse: "dev-team",
		capabilities: ["run", "delegate"],
		specialization: undefined,
		status: "idle",
		lastHeartbeat: new Date().toISOString(),
		endpoint: "http://localhost:3000",
		models: ["anthropic/claude-sonnet-4"],
		activeJobs: 0,
		completedJobs: 0,
		health: { uptime: 1000, missedPings: 0 },
		...overrides,
	};
}

describe("mesh collaboration E2E", () => {
	test("two instances collaborate across specializations", async () => {
		// Create 2 MemoryMeshRegistry instances (simulating 2 Randal instances)
		// In practice each Randal instance has its own registry, but they share
		// state via Meilisearch. For testing, we use a single shared MemoryMeshRegistry.
		const registry = new MemoryMeshRegistry();

		// Register both in same posse with different specializations
		const frontend = makeInstance({
			instanceId: "inst-frontend",
			name: "frontend-agent",
			posse: "dev-team",
			specialization: "frontend",
		});

		const backend = makeInstance({
			instanceId: "inst-backend",
			name: "backend-agent",
			posse: "dev-team",
			specialization: "backend",
		});

		await registry.register(frontend);
		await registry.register(backend);

		// Verify both registered
		expect(await registry.count()).toBe(2);

		// Discover by posse
		const posseInstances = await registry.discover({ posse: "dev-team" });
		expect(posseInstances).toHaveLength(2);

		// Route a frontend task → verify routes to frontend instance
		const frontendDecision = routeTask(posseInstances, {
			prompt: "Build a React dashboard component",
			domain: "frontend",
		});

		expect(frontendDecision).not.toBeNull();
		if (frontendDecision) {
			expect(frontendDecision.instance.instanceId).toBe("inst-frontend");
			expect(frontendDecision.instance.specialization).toBe("frontend");
			expect(frontendDecision.breakdown.specializationScore).toBe(1.0);
		}

		// Route a backend task → verify routes to backend instance
		const backendDecision = routeTask(posseInstances, {
			prompt: "Create a REST API with authentication",
			domain: "backend",
		});

		expect(backendDecision).not.toBeNull();
		if (backendDecision) {
			expect(backendDecision.instance.instanceId).toBe("inst-backend");
			expect(backendDecision.instance.specialization).toBe("backend");
			expect(backendDecision.breakdown.specializationScore).toBe(1.0);
		}
	});

	test("routing falls back to remaining healthy instance", async () => {
		const registry = new MemoryMeshRegistry();

		const frontend = makeInstance({
			instanceId: "inst-frontend",
			name: "frontend-agent",
			posse: "dev-team",
			specialization: "frontend",
			status: "idle",
		});

		const backend = makeInstance({
			instanceId: "inst-backend",
			name: "backend-agent",
			posse: "dev-team",
			specialization: "backend",
			status: "idle",
		});

		await registry.register(frontend);
		await registry.register(backend);

		// Simulate one instance going unhealthy
		await registry.updateHeartbeat("inst-frontend", "unhealthy", 0);

		// Discover all instances (including unhealthy)
		const allInstances = await registry.discover({ posse: "dev-team" });
		expect(allInstances).toHaveLength(2);

		// Route a frontend task — frontend is unhealthy, should fall back
		const decision = routeTask(allInstances, {
			prompt: "Build a React component",
			domain: "frontend",
		});

		expect(decision).not.toBeNull();
		if (decision) {
			// Should route to backend since frontend is unhealthy
			expect(decision.instance.instanceId).toBe("inst-backend");
		}
	});

	test("routing with all instances unhealthy returns null", async () => {
		const registry = new MemoryMeshRegistry();

		const inst1 = makeInstance({
			instanceId: "inst-1",
			name: "agent-1",
			status: "unhealthy",
		});
		const inst2 = makeInstance({
			instanceId: "inst-2",
			name: "agent-2",
			status: "offline",
		});

		await registry.register(inst1);
		await registry.register(inst2);

		const instances = await registry.discover();
		const decision = routeTask(instances, {
			prompt: "Do something",
			domain: "backend",
		});

		expect(decision).toBeNull();
	});

	test("stale instance cleanup removes old heartbeats", async () => {
		const registry = new MemoryMeshRegistry();

		const staleInstance = makeInstance({
			instanceId: "inst-stale",
			name: "stale-agent",
			lastHeartbeat: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
		});
		const freshInstance = makeInstance({
			instanceId: "inst-fresh",
			name: "fresh-agent",
			lastHeartbeat: new Date().toISOString(),
		});

		await registry.register(staleInstance);
		await registry.register(freshInstance);
		expect(await registry.count()).toBe(2);

		// Cleanup with 60-second timeout
		const removed = await registry.cleanupStale(60_000);
		expect(removed).toContain("inst-stale");
		expect(removed).not.toContain("inst-fresh");
		expect(await registry.count()).toBe(1);
	});
});
