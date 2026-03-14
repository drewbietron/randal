import { describe, expect, test } from "bun:test";

describe("run command", () => {
	test("module exports runCommand function", async () => {
		const mod = await import("./run.js");
		expect(typeof mod.runCommand).toBe("function");
	});
});
