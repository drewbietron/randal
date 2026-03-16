import { describe, expect, test } from "bun:test";
import { parsePosseConfig } from "./posse-config.js";

describe("posseConfigSchema", () => {
	test("parses valid minimal config", () => {
		const result = parsePosseConfig(`
name: pbv-team
agents:
  - name: meeles
    config: ./packages/meeles/randal.config.yaml
`);
		expect(result.name).toBe("pbv-team");
		expect(result.version).toBe("0.1");
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0].name).toBe("meeles");
		expect(result.memory.topology).toBe("full-mesh");
		expect(result.infrastructure.meilisearch.mode).toBe("embedded");
	});

	test("parses full config with all fields", () => {
		const result = parsePosseConfig(`
name: research-team
version: "1.0"
infrastructure:
  meilisearch:
    mode: shared
    url: http://meili.example.com:7700
    apiKey: master-key-123
agents:
  - name: alpha
    config: ./agent-a.yaml
  - name: beta
    config: ./agent-b.yaml
memory:
  topology: hub-spoke
  sharedIndex: shared-research
`);
		expect(result.name).toBe("research-team");
		expect(result.version).toBe("1.0");
		expect(result.infrastructure.meilisearch.mode).toBe("shared");
		expect(result.infrastructure.meilisearch.url).toBe("http://meili.example.com:7700");
		expect(result.infrastructure.meilisearch.apiKey).toBe("master-key-123");
		expect(result.agents).toHaveLength(2);
		expect(result.memory.topology).toBe("hub-spoke");
		expect(result.memory.sharedIndex).toBe("shared-research");
	});

	test("applies defaults", () => {
		const result = parsePosseConfig(`
name: test
agents:
  - name: agent1
    config: ./config.yaml
`);
		expect(result.version).toBe("0.1");
		expect(result.infrastructure.meilisearch.mode).toBe("embedded");
		expect(result.memory.topology).toBe("full-mesh");
	});

	test("rejects missing name", () => {
		expect(() =>
			parsePosseConfig(`
agents:
  - name: agent1
    config: ./config.yaml
`),
		).toThrow();
	});

	test("rejects empty agents array", () => {
		expect(() =>
			parsePosseConfig(`
name: test
agents: []
`),
		).toThrow();
	});

	test("rejects agent without name", () => {
		expect(() =>
			parsePosseConfig(`
name: test
agents:
  - config: ./config.yaml
`),
		).toThrow();
	});

	test("rejects agent without config", () => {
		expect(() =>
			parsePosseConfig(`
name: test
agents:
  - name: agent1
`),
		).toThrow();
	});

	test("supports env var substitution", () => {
		const origUrl = process.env.TEST_MEILI_URL;
		process.env.TEST_MEILI_URL = "http://test-meili:7700";

		try {
			const result = parsePosseConfig(`
name: test
agents:
  - name: agent1
    config: ./config.yaml
infrastructure:
  meilisearch:
    mode: shared
    url: "\${TEST_MEILI_URL}"
    apiKey: test
`);
			expect(result.infrastructure.meilisearch.url).toBe("http://test-meili:7700");
		} finally {
			if (origUrl === undefined) {
				process.env.TEST_MEILI_URL = undefined;
			} else {
				process.env.TEST_MEILI_URL = origUrl;
			}
		}
	});

	test("accepts manual topology", () => {
		const result = parsePosseConfig(`
name: test
agents:
  - name: agent1
    config: ./config.yaml
memory:
  topology: manual
`);
		expect(result.memory.topology).toBe("manual");
	});
});
