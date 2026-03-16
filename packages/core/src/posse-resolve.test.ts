import { describe, expect, test } from "bun:test";
import { parsePosseConfig } from "./posse-config.js";
import { resolvePosseConfig } from "./posse-resolve.js";

describe("resolvePosseConfig", () => {
	test("full-mesh with 2 agents injects correct sharing config", () => {
		const manifest = parsePosseConfig(`
name: pbv-team
agents:
  - name: meeles
    config: ./meeles/randal.config.yaml
  - name: ops
    config: ./ops/randal.config.yaml
memory:
  topology: full-mesh
`);

		const results = resolvePosseConfig(manifest);
		expect(results).toHaveLength(2);

		const meeles = results.find((r) => r.name === "meeles");
		const ops = results.find((r) => r.name === "ops");

		expect(meeles).toBeDefined();
		expect(ops).toBeDefined();

		// meeles should publish to shared and read from shared + ops' private index
		expect(meeles?.memorySharing.publishTo).toBe("shared-pbv-team");
		expect(meeles?.memorySharing.readFrom).toContain("shared-pbv-team");
		expect(meeles?.memorySharing.readFrom).toContain("memory-ops");
		expect(meeles?.memorySharing.readFrom).not.toContain("memory-meeles");

		// ops should publish to shared and read from shared + meeles' private index
		expect(ops?.memorySharing.publishTo).toBe("shared-pbv-team");
		expect(ops?.memorySharing.readFrom).toContain("shared-pbv-team");
		expect(ops?.memorySharing.readFrom).toContain("memory-meeles");
		expect(ops?.memorySharing.readFrom).not.toContain("memory-ops");
	});

	test("full-mesh with 3 agents", () => {
		const manifest = parsePosseConfig(`
name: team
agents:
  - name: a
    config: ./a.yaml
  - name: b
    config: ./b.yaml
  - name: c
    config: ./c.yaml
memory:
  topology: full-mesh
`);

		const results = resolvePosseConfig(manifest);
		expect(results).toHaveLength(3);

		const a = results.find((r) => r.name === "a");
		expect(a).toBeDefined();
		expect(a?.memorySharing.readFrom).toContain("shared-team");
		expect(a?.memorySharing.readFrom).toContain("memory-b");
		expect(a?.memorySharing.readFrom).toContain("memory-c");
		expect(a?.memorySharing.readFrom).not.toContain("memory-a");
	});

	test("hub-spoke restricts reading to shared index only", () => {
		const manifest = parsePosseConfig(`
name: team
agents:
  - name: meeles
    config: ./meeles.yaml
  - name: ops
    config: ./ops.yaml
memory:
  topology: hub-spoke
`);

		const results = resolvePosseConfig(manifest);
		const meeles = results.find((r) => r.name === "meeles");
		expect(meeles).toBeDefined();

		expect(meeles?.memorySharing.publishTo).toBe("shared-team");
		expect(meeles?.memorySharing.readFrom).toEqual(["shared-team"]);
		// Should NOT include other agent's private index
		expect(meeles?.memorySharing.readFrom).not.toContain("memory-ops");
	});

	test("manual topology applies no injection", () => {
		const manifest = parsePosseConfig(`
name: team
agents:
  - name: agent1
    config: ./agent1.yaml
  - name: agent2
    config: ./agent2.yaml
memory:
  topology: manual
`);

		const results = resolvePosseConfig(manifest);
		for (const result of results) {
			expect(result.memorySharing.publishTo).toBeUndefined();
			expect(result.memorySharing.readFrom).toEqual([]);
			expect(result.skillsSharing.publishTo).toBeUndefined();
			expect(result.skillsSharing.readFrom).toEqual([]);
		}
	});

	test("shared infrastructure mode injects URL/apiKey", () => {
		const manifest = parsePosseConfig(`
name: team
infrastructure:
  meilisearch:
    mode: shared
    url: http://shared-meili:7700
    apiKey: shared-key
agents:
  - name: agent1
    config: ./agent1.yaml
`);

		const results = resolvePosseConfig(manifest);
		expect(results[0].infrastructure).toBeDefined();
		expect(results[0].infrastructure?.memoryUrl).toBe("http://shared-meili:7700");
		expect(results[0].infrastructure?.memoryApiKey).toBe("shared-key");
		expect(results[0].infrastructure?.skipMeilisearch).toBe(true);
	});

	test("embedded mode does not inject infrastructure", () => {
		const manifest = parsePosseConfig(`
name: team
infrastructure:
  meilisearch:
    mode: embedded
agents:
  - name: agent1
    config: ./agent1.yaml
`);

		const results = resolvePosseConfig(manifest);
		expect(results[0].infrastructure).toBeUndefined();
	});

	test("rejects duplicate agent names", () => {
		const manifest = parsePosseConfig(`
name: team
agents:
  - name: agent1
    config: ./a.yaml
  - name: agent1
    config: ./b.yaml
`);

		expect(() => resolvePosseConfig(manifest)).toThrow("Duplicate agent names");
	});

	test("uses custom sharedIndex when specified", () => {
		const manifest = parsePosseConfig(`
name: team
agents:
  - name: agent1
    config: ./agent1.yaml
memory:
  topology: full-mesh
  sharedIndex: custom-shared-idx
`);

		const results = resolvePosseConfig(manifest);
		expect(results[0].memorySharing.publishTo).toBe("custom-shared-idx");
		expect(results[0].memorySharing.readFrom).toContain("custom-shared-idx");
	});

	test("shared mode without url throws", () => {
		const manifest = parsePosseConfig(`
name: team
infrastructure:
  meilisearch:
    mode: shared
    apiKey: key
agents:
  - name: agent1
    config: ./agent1.yaml
`);

		expect(() => resolvePosseConfig(manifest)).toThrow("requires url and apiKey");
	});

	test("full-mesh skills sharing mirrors memory topology", () => {
		const manifest = parsePosseConfig(`
name: team
agents:
  - name: a
    config: ./a.yaml
  - name: b
    config: ./b.yaml
memory:
  topology: full-mesh
`);

		const results = resolvePosseConfig(manifest);
		const a = results.find((r) => r.name === "a");
		expect(a).toBeDefined();

		expect(a?.skillsSharing.publishTo).toBe("shared-skills-team");
		expect(a?.skillsSharing.readFrom).toContain("shared-skills-team");
		expect(a?.skillsSharing.readFrom).toContain("skills-b");
	});
});
