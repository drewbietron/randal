import { describe, expect, test } from "bun:test";
import {
	discoverPosseMembers,
	filterPosseIndexes,
	parseAgentNameFromIndex,
	parseIndexName,
} from "./posse-discovery.js";

describe("parseIndexName", () => {
	test("parses agent memory index", () => {
		const info = parseIndexName("memory-meeles");
		expect(info.type).toBe("agent-memory");
		expect(info.agentName).toBe("meeles");
	});

	test("parses shared memory index", () => {
		const info = parseIndexName("shared-pbv-team");
		expect(info.type).toBe("shared-memory");
		expect(info.posseName).toBe("pbv-team");
	});

	test("parses agent skills index", () => {
		const info = parseIndexName("skills-meeles");
		expect(info.type).toBe("agent-skills");
		expect(info.agentName).toBe("meeles");
	});

	test("parses shared skills index", () => {
		const info = parseIndexName("shared-skills-pbv-team");
		expect(info.type).toBe("shared-skills");
		expect(info.posseName).toBe("pbv-team");
	});

	test("parses posse registry index", () => {
		const info = parseIndexName("posse-registry-pbv-team");
		expect(info.type).toBe("posse-registry");
		expect(info.posseName).toBe("pbv-team");
	});

	test("returns unknown for non-matching index", () => {
		const info = parseIndexName("other-index");
		expect(info.type).toBe("unknown");
	});

	test("handles hyphenated agent names", () => {
		const info = parseIndexName("memory-my-agent-name");
		expect(info.type).toBe("agent-memory");
		expect(info.agentName).toBe("my-agent-name");
	});

	test("handles hyphenated posse names", () => {
		const info = parseIndexName("shared-my-team-name");
		expect(info.type).toBe("shared-memory");
		expect(info.posseName).toBe("my-team-name");
	});
});

describe("parseAgentNameFromIndex", () => {
	test("extracts agent name from memory index", () => {
		expect(parseAgentNameFromIndex("memory-meeles")).toBe("meeles");
	});

	test("returns undefined for non-memory index", () => {
		expect(parseAgentNameFromIndex("shared-team")).toBeUndefined();
	});

	test("returns undefined for skills index", () => {
		expect(parseAgentNameFromIndex("skills-meeles")).toBeUndefined();
	});
});

describe("filterPosseIndexes", () => {
	const allIndexes = [
		"memory-meeles",
		"memory-ops",
		"shared-pbv-team",
		"shared-other-team",
		"skills-meeles",
		"skills-ops",
		"shared-skills-pbv-team",
		"posse-registry-pbv-team",
		"posse-registry-other-team",
		"random-index",
	];

	test("filters agent memory indexes", () => {
		const result = filterPosseIndexes(allIndexes);
		expect(result.agentMemoryIndexes).toHaveLength(2);
		expect(result.agentMemoryIndexes.map((i) => i.agentName)).toEqual(["meeles", "ops"]);
	});

	test("filters shared memory indexes by posse name", () => {
		const result = filterPosseIndexes(allIndexes, "pbv-team");
		expect(result.sharedMemoryIndexes).toHaveLength(1);
		expect(result.sharedMemoryIndexes[0].posseName).toBe("pbv-team");
	});

	test("filters registry indexes by posse name", () => {
		const result = filterPosseIndexes(allIndexes, "pbv-team");
		expect(result.registryIndexes).toHaveLength(1);
		expect(result.registryIndexes[0].posseName).toBe("pbv-team");
	});

	test("returns all shared when no posse name filter", () => {
		const result = filterPosseIndexes(allIndexes);
		expect(result.sharedMemoryIndexes).toHaveLength(2);
		expect(result.registryIndexes).toHaveLength(2);
	});
});

describe("discoverPosseMembers", () => {
	test("discovers agents from memory indexes", () => {
		const members = discoverPosseMembers([
			"memory-meeles",
			"memory-ops",
			"shared-pbv-team",
			"skills-meeles",
		]);
		expect(members).toEqual(["meeles", "ops"]);
	});

	test("returns empty for no memory indexes", () => {
		const members = discoverPosseMembers(["shared-team", "skills-agent"]);
		expect(members).toEqual([]);
	});
});
