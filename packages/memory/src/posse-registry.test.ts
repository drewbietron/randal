import { describe, expect, test } from "bun:test";
import { parseConfig } from "@randal/core";
import {
	type RegistryDoc,
	buildRegistryDoc,
	getRegistryIndexName,
	isStale,
	markStaleEntries,
} from "./posse-registry.js";

function makeConfig(posse?: string) {
	const posseConfig = posse ? `\nposse: ${posse}` : "";
	return parseConfig(`
name: test-agent${posseConfig}
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
