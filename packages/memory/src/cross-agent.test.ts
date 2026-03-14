import { describe, expect, test } from "bun:test";
import { parseConfig } from "@randal/core";
import { searchCrossAgent } from "./cross-agent.js";

describe("crossAgent", () => {
	test("returns empty when no readFrom configured", async () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
memory:
  url: http://localhost:7700
  apiKey: test
  sharing:
    readFrom: []
`);
		const results = await searchCrossAgent("test", config);
		expect(results).toEqual([]);
	});
});
