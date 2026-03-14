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

	test("config accepts store field with file value", () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
memory:
  store: file
`);
		// The 'store' field is now a valid schema field
		expect(config.memory.store).toBe("file");
		// Meilisearch defaults are still applied (for fallback)
		expect(config.memory.url).toBe("http://localhost:7700");
	});

	test("config defaults store to meilisearch", () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
`);
		expect(config.memory.store).toBe("meilisearch");
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
