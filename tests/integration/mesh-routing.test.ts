import { describe, expect, test } from "bun:test";
import type { MeshInstance } from "@randal/core";
import { MemoryMeshRegistry, routeTask } from "@randal/mesh";

function makeInstance(overrides: Partial<MeshInstance> = {}): MeshInstance {
	return {
		instanceId: `inst-${Math.random().toString(36).slice(2, 10)}`,
		name: "test-instance",
		posse: "test-posse",
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

describe("mesh routing integration", () => {
	test("create MemoryMeshRegistry with 3 instances", async () => {
		const registry = new MemoryMeshRegistry();

		const frontend = makeInstance({
			instanceId: "inst-frontend",
			name: "frontend-specialist",
			specialization: "frontend",
		});
		const backend = makeInstance({
			instanceId: "inst-backend",
			name: "backend-specialist",
			specialization: "backend",
		});
		const general = makeInstance({
			instanceId: "inst-general",
			name: "general-agent",
		});

		await registry.register(frontend);
		await registry.register(backend);
		await registry.register(general);

		expect(await registry.count()).toBe(3);
	});

	test("routeTask selects frontend-specialized instance for frontend task", async () => {
		const registry = new MemoryMeshRegistry();

		const frontend = makeInstance({
			instanceId: "inst-frontend",
			name: "frontend-specialist",
			specialization: "frontend",
		});
		const backend = makeInstance({
			instanceId: "inst-backend",
			name: "backend-specialist",
			specialization: "backend",
		});
		const general = makeInstance({
			instanceId: "inst-general",
			name: "general-agent",
		});

		await registry.register(frontend);
		await registry.register(backend);
		await registry.register(general);

		const instances = await registry.discover();
		const decision = routeTask(instances, {
			prompt: "Build a React component",
			domain: "frontend",
		});

		expect(decision).not.toBeNull();
		expect(decision?.instance.instanceId).toBe("inst-frontend");
		expect(decision?.breakdown.specializationScore).toBe(1.0);
	});

	test("routeTask selects backend-specialized instance for backend task", async () => {
		const registry = new MemoryMeshRegistry();

		const frontend = makeInstance({
			instanceId: "inst-frontend",
			name: "frontend-specialist",
			specialization: "frontend",
		});
		const backend = makeInstance({
			instanceId: "inst-backend",
			name: "backend-specialist",
			specialization: "backend",
		});

		await registry.register(frontend);
		await registry.register(backend);

		const instances = await registry.discover();
		const decision = routeTask(instances, {
			prompt: "Create REST API endpoint",
			domain: "backend",
		});

		expect(decision).not.toBeNull();
		expect(decision?.instance.instanceId).toBe("inst-backend");
		expect(decision?.breakdown.specializationScore).toBe(1.0);
	});

	test("routeTask prefers idle instances over busy ones", async () => {
		const registry = new MemoryMeshRegistry();

		const busy = makeInstance({
			instanceId: "inst-busy",
			name: "busy-backend",
			specialization: "backend",
			status: "busy",
			activeJobs: 3,
		});
		const idle = makeInstance({
			instanceId: "inst-idle",
			name: "idle-backend",
			specialization: "backend",
			status: "idle",
			activeJobs: 0,
		});

		await registry.register(busy);
		await registry.register(idle);

		const instances = await registry.discover();
		const decision = routeTask(instances, {
			prompt: "Create API endpoint",
			domain: "backend",
		});

		expect(decision).not.toBeNull();
		// The idle instance should win due to higher load score
		expect(decision?.instance.instanceId).toBe("inst-idle");
	});

	test("routeTask returns null for unhealthy instances", async () => {
		const registry = new MemoryMeshRegistry();

		const unhealthy = makeInstance({
			instanceId: "inst-1",
			name: "unhealthy-agent",
			specialization: "backend",
			status: "unhealthy",
		});

		await registry.register(unhealthy);

		const instances = await registry.discover();
		const decision = routeTask(instances, {
			prompt: "Build an API",
			domain: "backend",
		});

		// Should return null since the only instance is unhealthy
		expect(decision).toBeNull();
	});
});
