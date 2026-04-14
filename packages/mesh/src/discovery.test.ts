import { describe, expect, test } from "bun:test";
import type { MeshInstance } from "@randal/core";
import { filterInstances, findBestForRole } from "./discovery.js";

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

describe("filterInstances", () => {
	test("excludes self by instanceId", () => {
		const instances = [
			makeInstance({ instanceId: "self-id" }),
			makeInstance({ instanceId: "peer-1" }),
			makeInstance({ instanceId: "peer-2" }),
		];

		const result = filterInstances(instances, { excludeInstanceId: "self-id" });
		expect(result.instances).toHaveLength(2);
		expect(result.total).toBe(2);
		expect(result.instances.find((i) => i.instanceId === "self-id")).toBeUndefined();
	});

	test("filters by posse", () => {
		const instances = [
			makeInstance({ instanceId: "inst-1", posse: "team-a" }),
			makeInstance({ instanceId: "inst-2", posse: "team-b" }),
			makeInstance({ instanceId: "inst-3", posse: "team-a" }),
		];

		const result = filterInstances(instances, { posse: "team-a" });
		expect(result.instances).toHaveLength(2);
		expect(result.instances.every((i) => i.posse === "team-a")).toBe(true);
	});

	test("filters by status", () => {
		const instances = [
			makeInstance({ instanceId: "inst-1", status: "idle" }),
			makeInstance({ instanceId: "inst-2", status: "busy" }),
			makeInstance({ instanceId: "inst-3", status: "unhealthy" }),
		];

		const result = filterInstances(instances, { status: "idle" });
		expect(result.instances).toHaveLength(1);
		expect(result.instances[0].status).toBe("idle");
	});

	test("returns healthy count excluding unhealthy and offline", () => {
		const instances = [
			makeInstance({ status: "idle" }),
			makeInstance({ status: "busy" }),
			makeInstance({ status: "unhealthy" }),
			makeInstance({ status: "offline" }),
		];

		const result = filterInstances(instances);
		expect(result.total).toBe(4);
		expect(result.healthy).toBe(2); // idle + busy
		expect(result.busy).toBe(1);
	});

	test("returns all instances when no filters provided", () => {
		const instances = [
			makeInstance({ instanceId: "inst-1" }),
			makeInstance({ instanceId: "inst-2" }),
		];

		const result = filterInstances(instances);
		expect(result.instances).toHaveLength(2);
		expect(result.total).toBe(2);
	});

	test("combines multiple filters", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-1",
				posse: "team-a",
				role: "product-engineering",
				status: "idle",
			}),
			makeInstance({
				instanceId: "inst-2",
				posse: "team-a",
				role: "security-compliance",
				status: "idle",
			}),
			makeInstance({
				instanceId: "inst-3",
				posse: "team-b",
				role: "product-engineering",
				status: "idle",
			}),
		];

		const result = filterInstances(instances, {
			posse: "team-a",
			role: "product-engineering",
		});
		expect(result.instances).toHaveLength(1);
		expect(result.instances[0].instanceId).toBe("inst-1");
	});

	test("returns empty when no instances match", () => {
		const instances = [makeInstance({ posse: "team-a" })];

		const result = filterInstances(instances, { posse: "team-z" });
		expect(result.instances).toHaveLength(0);
		expect(result.total).toBe(0);
		expect(result.healthy).toBe(0);
	});
});

describe("filterInstances with role", () => {
	test("filters by role", () => {
		const instances = [
			makeInstance({ instanceId: "inst-1", role: "product-engineering" }),
			makeInstance({ instanceId: "inst-2", role: "security-compliance" }),
			makeInstance({ instanceId: "inst-3", role: "product-engineering" }),
		];

		const result = filterInstances(instances, { role: "product-engineering" });
		expect(result.instances).toHaveLength(2);
		expect(result.instances.every((i) => i.role === "product-engineering")).toBe(true);
	});

	test("role filter excludes instances without role field", () => {
		const instances = [
			makeInstance({ instanceId: "inst-with-role", role: "product-engineering" }),
			makeInstance({ instanceId: "inst-no-role" }),
		];

		const result = filterInstances(instances, { role: "product-engineering" });
		expect(result.instances).toHaveLength(1);
		expect(result.instances[0].instanceId).toBe("inst-with-role");
	});
});

describe("findBestForRole", () => {
	test("returns matching idle instance", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-1",
				role: "product-engineering",
				status: "idle",
				activeJobs: 0,
			}),
			makeInstance({
				instanceId: "inst-2",
				role: "security-compliance",
				status: "idle",
				activeJobs: 0,
			}),
		];

		const result = findBestForRole(instances, "product-engineering");
		expect(result).not.toBeNull();
		expect(result?.instanceId).toBe("inst-1");
		expect(result?.role).toBe("product-engineering");
	});

	test("prefers idle over busy", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-busy",
				role: "product-engineering",
				status: "busy",
				activeJobs: 2,
			}),
			makeInstance({
				instanceId: "inst-idle",
				role: "product-engineering",
				status: "idle",
				activeJobs: 0,
			}),
		];

		const result = findBestForRole(instances, "product-engineering");
		expect(result).not.toBeNull();
		expect(result?.instanceId).toBe("inst-idle");
	});

	test("returns null when no role match found", () => {
		const instances = [makeInstance({ role: "security-compliance", status: "idle" })];

		const result = findBestForRole(instances, "product-engineering");
		expect(result).toBeNull();
	});

	test("returns null for unhealthy instances matching role", () => {
		const instances = [
			makeInstance({
				role: "product-engineering",
				status: "unhealthy",
			}),
			makeInstance({
				role: "product-engineering",
				status: "offline",
			}),
		];

		const result = findBestForRole(instances, "product-engineering");
		expect(result).toBeNull();
	});

	test("returns null for empty array", () => {
		const result = findBestForRole([], "product-engineering");
		expect(result).toBeNull();
	});
});
