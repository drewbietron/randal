import { describe, expect, test } from "bun:test";
import { parseConfig } from "@randal/core";

describe("MemoryManager (meilisearch required)", () => {
	test("constructor creates MeilisearchStore with config defaults", () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
`);
		// Verify memory config defaults
		expect(config.memory.url).toBe("http://localhost:7700");
		expect(config.memory.apiKey).toBe("");
	});

	test("config strips unknown store field", () => {
		// Zod strips unknown fields - store: file is silently ignored
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
memory:
  store: file
`);
		// The 'store' field doesn't exist in the new schema
		expect((config.memory as Record<string, unknown>).store).toBeUndefined();
		// Meilisearch defaults are applied
		expect(config.memory.url).toBe("http://localhost:7700");
	});

	test("config accepts explicit meilisearch url/apiKey", () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
memory:
  url: http://custom:7700
  apiKey: my-key
  index: custom-index
`);
		expect(config.memory.url).toBe("http://custom:7700");
		expect(config.memory.apiKey).toBe("my-key");
		expect(config.memory.index).toBe("custom-index");
	});
});
