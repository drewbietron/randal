import { describe, expect, test } from "bun:test";
import { getPrimaryDomain } from "@randal/analytics";
import type { MeshInstance } from "@randal/core";
import { MemoryMeshRegistry, dryRunRoute, routeTask } from "@randal/mesh";

function makeInstance(overrides: Partial<MeshInstance> = {}): MeshInstance {
	return {
		instanceId: `inst-${Math.random().toString(36).slice(2, 10)}`,
		name: "test-instance",
		posse: "test-posse",
		capabilities: ["run", "delegate"],
		specialization: undefined,
		role: undefined,
		expertise: undefined,
		expertiseVector: undefined,
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

describe("semantic mesh routing", () => {
	test("routeTask selects instance by expertise vector similarity", async () => {
		const registry = new MemoryMeshRegistry();

		// Use L2-normalized vectors so dot product = cosine similarity
		const instReact = makeInstance({
			instanceId: "inst-react",
			name: "react-specialist",
			role: "product-engineering",
			expertise: "React, TypeScript, frontend architecture",
			expertiseVector: [0.9939, 0.1104, 0.0, 0.0], // normalized ~[0.9, 0.1]
		});
		const instSecurity = makeInstance({
			instanceId: "inst-security",
			name: "security-specialist",
			role: "security-compliance",
			expertise: "AppSec, penetration testing, OWASP",
			expertiseVector: [0.0, 0.0, 0.9939, 0.1104], // normalized ~[0, 0, 0.9, 0.1]
		});
		const instGeneral = makeInstance({
			instanceId: "inst-general",
			name: "general-agent",
		});

		await registry.register(instReact);
		await registry.register(instSecurity);
		await registry.register(instGeneral);

		const instances = await registry.discover();
		const decision = routeTask(instances, {
			prompt: "Fix the React component",
			domain: "product-engineering",
			taskVector: [0.9986, 0.0526, 0.0, 0.0], // normalized ~[0.95, 0.05]
		});

		expect(decision).not.toBeNull();
		expect(decision?.instance.instanceId).toBe("inst-react");
		// Cosine similarity of similar normalized vectors ≈ 0.998
		expect(decision?.breakdown.expertiseScore).toBeGreaterThan(0.9);
	});

	test("routeTask falls back to role match when no vectors available", async () => {
		const registry = new MemoryMeshRegistry();

		const instEng = makeInstance({
			instanceId: "inst-eng",
			name: "eng-agent",
			role: "product-engineering",
		});
		const instSec = makeInstance({
			instanceId: "inst-sec",
			name: "sec-agent",
			role: "security-compliance",
		});

		await registry.register(instEng);
		await registry.register(instSec);

		const instances = await registry.discover();
		const decision = routeTask(instances, {
			prompt: "Build an API",
			domain: "product-engineering",
		});

		expect(decision).not.toBeNull();
		expect(decision?.instance.instanceId).toBe("inst-eng");
		// Tier 2 exact role match gives 1.0
		expect(decision?.breakdown.expertiseScore).toBe(1.0);
	});

	test("routeTask handles mixed mesh: some instances with vectors, some without", async () => {
		const registry = new MemoryMeshRegistry();

		// inst-a: has expertise vector that closely matches the task vector
		// Using the same normalized vector as the task so cosine similarity = 1.0
		const instA = makeInstance({
			instanceId: "inst-a",
			name: "vector-agent",
			role: "product-engineering",
			expertise: "React and TypeScript",
			expertiseVector: [1.0, 0.0, 0.0, 0.0],
		});
		// inst-b: role-only, no expertise vector — uses Tier 2 role match
		const instB = makeInstance({
			instanceId: "inst-b",
			name: "role-only-agent",
			role: "product-engineering",
		});
		// inst-c: legacy specialization only — uses Tier 3
		const instC = makeInstance({
			instanceId: "inst-c",
			name: "legacy-agent",
			specialization: "backend",
		});

		await registry.register(instA);
		await registry.register(instB);
		await registry.register(instC);

		const instances = await registry.discover();
		const decisions = dryRunRoute(instances, {
			prompt: "Build a React component",
			domain: "product-engineering",
			taskVector: [1.0, 0.0, 0.0, 0.0],
		});

		// All 3 should be scored
		expect(decisions.length).toBe(3);

		// inst-a and inst-b both get expertiseScore 1.0 (vector match vs role match)
		// but both should rank above inst-c (legacy fallback with partial/no match)
		const instADecision = decisions.find((d) => d.instance.instanceId === "inst-a");
		const instBDecision = decisions.find((d) => d.instance.instanceId === "inst-b");
		const instCDecision = decisions.find((d) => d.instance.instanceId === "inst-c");

		expect(instADecision).toBeDefined();
		expect(instBDecision).toBeDefined();
		expect(instCDecision).toBeDefined();

		// inst-a uses Tier 1 (semantic): expertiseScore = 1.0 (identical vectors)
		expect(instADecision?.breakdown.expertiseScore).toBe(1.0);
		// inst-b uses Tier 2 (role match): expertiseScore = 1.0
		expect(instBDecision?.breakdown.expertiseScore).toBe(1.0);
		// inst-c uses Tier 3 (legacy): "backend" partial match against "product-engineering" domain → 0.2
		expect(instCDecision?.breakdown.expertiseScore).toBeLessThan(0.5);

		// inst-c should rank last
		expect(decisions[2].instance.instanceId).toBe("inst-c");
	});

	test("backward compat: existing specialization-only routing still works", async () => {
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
		// With default weights (expertise: 0.4, specialization: 0.0),
		// computeExpertiseScore falls through to Tier 3 (legacy specialization match)
		// for instances with only specialization set
		const decision = routeTask(instances, {
			prompt: "Build a React component",
			domain: "frontend",
		});

		expect(decision).not.toBeNull();
		expect(decision?.instance.instanceId).toBe("inst-frontend");
		// Legacy specialization score is still computed and stored
		expect(decision?.breakdown.specializationScore).toBe(1.0);
		// Expertise score uses Tier 3 fallback (same as specialization logic)
		expect(decision?.breakdown.expertiseScore).toBe(1.0);
	});

	test("categorizer → router integration: auto-detected domain routes correctly", async () => {
		const registry = new MemoryMeshRegistry();

		const instEng = makeInstance({
			instanceId: "inst-eng",
			name: "eng-agent",
			role: "product-engineering",
		});
		const instInfra = makeInstance({
			instanceId: "inst-infra",
			name: "infra-agent",
			role: "platform-infrastructure",
		});

		await registry.register(instEng);
		await registry.register(instInfra);

		// Auto-detect domain from task prompt
		const domain = getPrimaryDomain("deploy docker to kubernetes cluster");
		expect(domain).toBe("platform-infrastructure");

		const instances = await registry.discover();
		const decision = routeTask(instances, {
			prompt: "deploy docker to kubernetes cluster",
			domain,
		});

		expect(decision).not.toBeNull();
		expect(decision?.instance.instanceId).toBe("inst-infra");
		expect(decision?.breakdown.expertiseScore).toBe(1.0);
	});
});
