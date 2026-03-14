import { describe, expect, test } from "bun:test";
import { opencode } from "./opencode.js";

describe("opencode adapter", () => {
	test("binary is opencode", () => {
		expect(opencode.binary).toBe("opencode");
	});

	test("builds basic command", () => {
		const cmd = opencode.buildCommand({
			prompt: "fix the bug",
			workdir: "/tmp",
		});
		expect(cmd).toEqual(["run", "fix the bug"]);
	});

	test("includes model flag", () => {
		const cmd = opencode.buildCommand({
			prompt: "fix the bug",
			model: "anthropic/claude-sonnet-4",
			workdir: "/tmp",
		});
		expect(cmd).toEqual(["run", "--model", "anthropic/claude-sonnet-4", "fix the bug"]);
	});
});
