import { describe, expect, test } from "bun:test";

describe("send command", () => {
	test("module exports sendCommand function", async () => {
		const mod = await import("./send.js");
		expect(typeof mod.sendCommand).toBe("function");
	});
});
