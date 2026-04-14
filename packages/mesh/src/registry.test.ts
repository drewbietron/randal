import { beforeEach, describe, expect, test } from "bun:test";
import type { MeshInstance } from "@randal/core";
import { MemoryMeshRegistry } from "./registry.js";

function makeInstance(overrides: Partial<MeshInstance> = {}): MeshInstance {
	return {
		instanceId: `inst-${Math.random().toString(36).slice(2, 8)}`,
		name: "test-agent",
		capabilities: ["run"],
		status: "idle",
		lastHeartbeat: new Date().toISOString(),
		endpoint: "http://localhost:7600",
		models: ["anthropic/claude-sonnet-4"],
		activeJobs: 0,
		completedJobs: 10,
		health: { uptime: 3600, missedPings: 0 },
		...overrides,
	};
}

describe("MemoryMeshRegistry", () => {
	let registry: MemoryMeshRegistry;

	beforeEach(() => {
		registry = new MemoryMeshRegistry();
	});

	test("register adds instance", async () => {
		const instance = makeInstance({ instanceId: "inst-abc" });
		await registry.register(instance);

		const result = await registry.get("inst-abc");
		expect(result).not.toBeNull();
		expect(result?.instanceId).toBe("inst-abc");
		expect(result?.name).toBe("test-agent");
	});

	test("register multiple instances", async () => {
		await registry.register(makeInstance({ instanceId: "inst-1" }));
		await registry.register(makeInstance({ instanceId: "inst-2" }));
		await registry.register(makeInstance({ instanceId: "inst-3" }));

		const count = await registry.count();
		expect(count).toBe(3);
	});

	test("deregister removes instance", async () => {
		const instance = makeInstance({ instanceId: "inst-abc" });
		await registry.register(instance);

		await registry.deregister("inst-abc");

		const result = await registry.get("inst-abc");
		expect(result).toBeNull();
		expect(await registry.count()).toBe(0);
	});

	test("deregister nonexistent instance is a no-op", async () => {
		await registry.deregister("nonexistent");
		expect(await registry.count()).toBe(0);
	});

	test("updateHeartbeat updates timestamp and status", async () => {
		const instance = makeInstance({
			instanceId: "inst-abc",
			status: "idle",
			activeJobs: 0,
		});
		await registry.register(instance);

		const beforeUpdate = instance.lastHeartbeat;
		// Small delay to ensure timestamp changes
		await new Promise((resolve) => setTimeout(resolve, 10));

		await registry.updateHeartbeat("inst-abc", "busy", 3);

		const updated = await registry.get("inst-abc");
		expect(updated?.status).toBe("busy");
		expect(updated?.activeJobs).toBe(3);
		expect(updated?.lastHeartbeat).not.toBe(beforeUpdate);
	});

	test("updateHeartbeat does nothing for nonexistent instance", async () => {
		// Should not throw
		await registry.updateHeartbeat("nonexistent", "busy", 1);
		expect(await registry.count()).toBe(0);
	});

	test("discover returns all instances when no filters", async () => {
		await registry.register(makeInstance({ instanceId: "inst-1" }));
		await registry.register(makeInstance({ instanceId: "inst-2" }));
		await registry.register(makeInstance({ instanceId: "inst-3" }));

		const results = await registry.discover();
		expect(results).toHaveLength(3);
	});

	test("discover filters by posse", async () => {
		await registry.register(makeInstance({ instanceId: "inst-1", posse: "team-a" }));
		await registry.register(makeInstance({ instanceId: "inst-2", posse: "team-b" }));
		await registry.register(makeInstance({ instanceId: "inst-3", posse: "team-a" }));

		const results = await registry.discover({ posse: "team-a" });
		expect(results).toHaveLength(2);
		expect(results.every((i) => i.posse === "team-a")).toBe(true);
	});

	test("discover filters by role", async () => {
		await registry.register(makeInstance({ instanceId: "inst-1", role: "frontend" }));
		await registry.register(makeInstance({ instanceId: "inst-2", role: "backend" }));
		await registry.register(makeInstance({ instanceId: "inst-3", role: "frontend" }));

		const results = await registry.discover({ role: "backend" });
		expect(results).toHaveLength(1);
		expect(results[0].role).toBe("backend");
	});

	test("discover filters by status", async () => {
		await registry.register(makeInstance({ instanceId: "inst-1", status: "idle" }));
		await registry.register(makeInstance({ instanceId: "inst-2", status: "busy" }));
		await registry.register(makeInstance({ instanceId: "inst-3", status: "idle" }));

		const results = await registry.discover({ status: "idle" });
		expect(results).toHaveLength(2);
		expect(results.every((i) => i.status === "idle")).toBe(true);
	});

	test("discover with combined filters", async () => {
		await registry.register(
			makeInstance({
				instanceId: "inst-1",
				posse: "team-a",
				role: "frontend",
				status: "idle",
			}),
		);
		await registry.register(
			makeInstance({
				instanceId: "inst-2",
				posse: "team-a",
				role: "backend",
				status: "idle",
			}),
		);
		await registry.register(
			makeInstance({
				instanceId: "inst-3",
				posse: "team-b",
				role: "frontend",
				status: "idle",
			}),
		);

		const results = await registry.discover({
			posse: "team-a",
			role: "frontend",
		});
		expect(results).toHaveLength(1);
		expect(results[0].instanceId).toBe("inst-1");
	});

	test("cleanupStale removes old instances", async () => {
		const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
		const recentTimestamp = new Date().toISOString();

		await registry.register(makeInstance({ instanceId: "inst-old", lastHeartbeat: oldTimestamp }));
		await registry.register(
			makeInstance({ instanceId: "inst-recent", lastHeartbeat: recentTimestamp }),
		);

		const removed = await registry.cleanupStale(60_000); // 60s timeout
		expect(removed).toContain("inst-old");
		expect(removed).not.toContain("inst-recent");
		expect(await registry.count()).toBe(1);
	});

	test("cleanupStale keeps fresh instances", async () => {
		await registry.register(
			makeInstance({
				instanceId: "inst-1",
				lastHeartbeat: new Date().toISOString(),
			}),
		);
		await registry.register(
			makeInstance({
				instanceId: "inst-2",
				lastHeartbeat: new Date().toISOString(),
			}),
		);

		const removed = await registry.cleanupStale(60_000);
		expect(removed).toEqual([]);
		expect(await registry.count()).toBe(2);
	});

	test("cleanupStale returns removed instance ids", async () => {
		const oldTimestamp = new Date(Date.now() - 300_000).toISOString();

		await registry.register(makeInstance({ instanceId: "inst-1", lastHeartbeat: oldTimestamp }));
		await registry.register(makeInstance({ instanceId: "inst-2", lastHeartbeat: oldTimestamp }));

		const removed = await registry.cleanupStale(60_000);
		expect(removed).toHaveLength(2);
		expect(removed).toContain("inst-1");
		expect(removed).toContain("inst-2");
	});

	test("concurrent registrations", async () => {
		const promises = Array.from({ length: 20 }, (_, i) =>
			registry.register(makeInstance({ instanceId: `inst-${i}` })),
		);

		await Promise.all(promises);
		expect(await registry.count()).toBe(20);

		const all = await registry.discover();
		expect(all).toHaveLength(20);
	});
});
