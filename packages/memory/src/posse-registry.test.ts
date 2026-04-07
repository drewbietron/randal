import { describe, expect, test } from "bun:test";
import { parseConfig } from "@randal/core";
import {
	type RegistryDoc,
	buildRegistryDoc,
	getRegistryIndexName,
	isStale,
	markStaleEntries,
	registryDocToMeshInstance,
} from "./posse-registry.js";

function makeConfig(posse?: string, mesh?: { endpoint?: string; specialization?: string }) {
	const posseConfig = posse ? `\nposse: ${posse}` : "";
	const meshLines: string[] = [];
	if (mesh?.endpoint || mesh?.specialization) {
		meshLines.push("\nmesh:");
		meshLines.push("  enabled: true");
		if (mesh.endpoint) meshLines.push(`  endpoint: ${mesh.endpoint}`);
		if (mesh.specialization) meshLines.push(`  specialization: ${mesh.specialization}`);
	}
	return parseConfig(`
name: test-agent${posseConfig}${meshLines.join("\n")}
runner:
  workdir: /tmp
  defaultAgent: mock
tools:
  - name: git
    binary: git
`);
}

describe("buildRegistryDoc", () => {
	test("creates a registry document from config", () => {
		const config = makeConfig("pbv-team");
		const doc = buildRegistryDoc(config);

		expect(doc.id).toBe("test-agent");
		expect(doc.name).toBe("test-agent");
		expect(doc.posse).toBe("pbv-team");
		expect(doc.capabilities).toEqual(["git"]);
		expect(doc.agent).toBe("mock");
		expect(doc.status).toBe("idle");
		expect(doc.version).toBe("0.1");
		expect(doc.lastHeartbeat).toBeTruthy();
		expect(doc.registeredAt).toBeTruthy();
	});

	test("accepts busy status", () => {
		const config = makeConfig("team");
		const doc = buildRegistryDoc(config, "busy");
		expect(doc.status).toBe("busy");
	});

	test("defaults to idle status", () => {
		const config = makeConfig("team");
		const doc = buildRegistryDoc(config);
		expect(doc.status).toBe("idle");
	});

	test("includes endpoint and specialization from mesh config", () => {
		const config = makeConfig("team", {
			endpoint: "http://localhost:3100",
			specialization: "frontend",
		});
		const doc = buildRegistryDoc(config);
		expect(doc.endpoint).toBe("http://localhost:3100");
		expect(doc.specialization).toBe("frontend");
	});

	test("leaves endpoint and specialization undefined when mesh config omits them", () => {
		const config = makeConfig("team");
		const doc = buildRegistryDoc(config);
		expect(doc.endpoint).toBeUndefined();
		expect(doc.specialization).toBeUndefined();
	});
});

describe("isStale", () => {
	test("returns false for recent heartbeat", () => {
		const doc: RegistryDoc = {
			id: "agent",
			name: "agent",
			posse: "team",
			capabilities: [],
			agent: "mock",
			status: "idle",
			version: "0.1",
			lastHeartbeat: new Date().toISOString(),
			registeredAt: new Date().toISOString(),
		};
		expect(isStale(doc)).toBe(false);
	});

	test("returns true for heartbeat older than 10 minutes", () => {
		const oldTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
		const doc: RegistryDoc = {
			id: "agent",
			name: "agent",
			posse: "team",
			capabilities: [],
			agent: "mock",
			status: "idle",
			version: "0.1",
			lastHeartbeat: oldTime,
			registeredAt: new Date().toISOString(),
		};
		expect(isStale(doc)).toBe(true);
	});

	test("returns false for heartbeat exactly at threshold", () => {
		// 9 minutes 59 seconds ago — should not be stale
		const borderTime = new Date(Date.now() - 9 * 60 * 1000).toISOString();
		const doc: RegistryDoc = {
			id: "agent",
			name: "agent",
			posse: "team",
			capabilities: [],
			agent: "mock",
			status: "idle",
			version: "0.1",
			lastHeartbeat: borderTime,
			registeredAt: new Date().toISOString(),
		};
		expect(isStale(doc)).toBe(false);
	});
});

describe("markStaleEntries", () => {
	test("marks stale entries", () => {
		const fresh: RegistryDoc = {
			id: "fresh",
			name: "fresh",
			posse: "team",
			capabilities: [],
			agent: "mock",
			status: "busy",
			version: "0.1",
			lastHeartbeat: new Date().toISOString(),
			registeredAt: new Date().toISOString(),
		};

		const staleDoc: RegistryDoc = {
			id: "old",
			name: "old",
			posse: "team",
			capabilities: [],
			agent: "mock",
			status: "idle",
			version: "0.1",
			lastHeartbeat: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
			registeredAt: new Date().toISOString(),
		};

		const result = markStaleEntries([fresh, staleDoc]);
		expect(result[0].status).toBe("busy");
		expect(result[1].status).toBe("stale");
	});

	test("does not double-mark already stale entries", () => {
		const alreadyStale: RegistryDoc = {
			id: "old",
			name: "old",
			posse: "team",
			capabilities: [],
			agent: "mock",
			status: "stale",
			version: "0.1",
			lastHeartbeat: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
			registeredAt: new Date().toISOString(),
		};

		const result = markStaleEntries([alreadyStale]);
		expect(result[0].status).toBe("stale");
	});
});

describe("getRegistryIndexName", () => {
	test("creates correct index name", () => {
		expect(getRegistryIndexName("pbv-team")).toBe("posse-registry-pbv-team");
	});
});

describe("registryDocToMeshInstance", () => {
	const baseDoc: RegistryDoc = {
		id: "agent-1",
		name: "agent-1",
		posse: "team",
		capabilities: ["git", "search"],
		agent: "mock",
		status: "idle",
		version: "0.1",
		lastHeartbeat: "2026-04-07T06:00:00.000Z",
		registeredAt: "2026-04-07T05:00:00.000Z",
		endpoint: "http://localhost:3100",
		specialization: "backend",
	};

	test("converts RegistryDoc to MeshInstance with correct field mapping", () => {
		const instance = registryDocToMeshInstance(baseDoc);
		expect(instance.instanceId).toBe("agent-1");
		expect(instance.name).toBe("agent-1");
		expect(instance.posse).toBe("team");
		expect(instance.capabilities).toEqual(["git", "search"]);
		expect(instance.specialization).toBe("backend");
		expect(instance.status).toBe("idle");
		expect(instance.lastHeartbeat).toBe("2026-04-07T06:00:00.000Z");
		expect(instance.endpoint).toBe("http://localhost:3100");
	});

	test("fills default values for fields not in RegistryDoc", () => {
		const instance = registryDocToMeshInstance(baseDoc);
		expect(instance.models).toEqual([]);
		expect(instance.activeJobs).toBe(0);
		expect(instance.completedJobs).toBe(0);
		expect(instance.health).toEqual({ uptime: 0, missedPings: 0 });
	});

	test("maps stale status to unhealthy", () => {
		const staleDoc: RegistryDoc = { ...baseDoc, status: "stale" };
		const instance = registryDocToMeshInstance(staleDoc);
		expect(instance.status).toBe("unhealthy");
		expect(instance.health.missedPings).toBe(3);
	});

	test("maps busy status correctly", () => {
		const busyDoc: RegistryDoc = { ...baseDoc, status: "busy" };
		const instance = registryDocToMeshInstance(busyDoc);
		expect(instance.status).toBe("busy");
	});

	test("handles missing endpoint and specialization", () => {
		const minimalDoc: RegistryDoc = {
			id: "agent-2",
			name: "agent-2",
			posse: "team",
			capabilities: [],
			agent: "mock",
			status: "idle",
			version: "0.1",
			lastHeartbeat: "2026-04-07T06:00:00.000Z",
			registeredAt: "2026-04-07T05:00:00.000Z",
		};
		const instance = registryDocToMeshInstance(minimalDoc);
		expect(instance.endpoint).toBe("");
		expect(instance.specialization).toBeUndefined();
	});

	test("handles empty posse string by converting to undefined", () => {
		const emptyPosseDoc: RegistryDoc = { ...baseDoc, posse: "" };
		const instance = registryDocToMeshInstance(emptyPosseDoc);
		expect(instance.posse).toBeUndefined();
	});
});
