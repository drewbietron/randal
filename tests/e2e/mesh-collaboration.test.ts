import { describe, expect, test } from "bun:test";
import type { MeshInstance } from "@randal/core";
import { MemoryMeshRegistry, routeTask } from "@randal/mesh";

function makeInstance(overrides: Partial<MeshInstance> = {}): MeshInstance {
	return {
		instanceId: `inst-${Math.random().toString(36).slice(2, 10)}`,
		name: "test-instance",
		posse: "dev-team",
		capabilities: ["run", "delegate"],
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
	test("two instances collaborate across different domains", async () => {
		// Create 2 MemoryMeshRegistry instances (simulating 2 Randal instances)
		// In practice each Randal instance has its own registry, but they share
		// state via Meilisearch. For testing, we use a single shared MemoryMeshRegistry.
		const registry = new MemoryMeshRegistry();

		// Register both in same posse with different roles
		const frontend = makeInstance({
			instanceId: "inst-frontend",
			name: "frontend-agent",
			posse: "dev-team",
			role: "product-engineering",
		});

		const infra = makeInstance({
			instanceId: "inst-infra",
			name: "infra-agent",
			posse: "dev-team",
			role: "platform-infrastructure",
		});

		await registry.register(frontend);
		await registry.register(infra);

		// Verify both registered
		expect(await registry.count()).toBe(2);

		// Discover by posse
		const posseInstances = await registry.discover({ posse: "dev-team" });
		expect(posseInstances).toHaveLength(2);

		// Route a frontend task → verify routes to frontend instance
		const frontendDecision = routeTask(posseInstances, {
			prompt: "Build a React dashboard component",
			domain: "product-engineering",
		});

		expect(frontendDecision).not.toBeNull();
		if (frontendDecision) {
			expect(frontendDecision.instance.instanceId).toBe("inst-frontend");
			expect(frontendDecision.instance.role).toBe("product-engineering");
			expect(frontendDecision.breakdown.expertiseScore).toBe(1.0);
		}

		// Route an infra task → verify routes to infra instance
		const infraDecision = routeTask(posseInstances, {
			prompt: "Deploy Kubernetes cluster with Terraform",
			domain: "platform-infrastructure",
		});

		expect(infraDecision).not.toBeNull();
		if (infraDecision) {
			expect(infraDecision.instance.instanceId).toBe("inst-infra");
			expect(infraDecision.instance.role).toBe("platform-infrastructure");
			expect(infraDecision.breakdown.expertiseScore).toBe(1.0);
		}
	});

	test("routing falls back to remaining healthy instance", async () => {
		const registry = new MemoryMeshRegistry();

		const frontend = makeInstance({
			instanceId: "inst-frontend",
			name: "frontend-agent",
			posse: "dev-team",
			role: "product-engineering",
			status: "idle",
		});

		const backend = makeInstance({
			instanceId: "inst-backend",
			name: "backend-agent",
			posse: "dev-team",
			role: "product-engineering",
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
			domain: "product-engineering",
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
			domain: "product-engineering",
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
