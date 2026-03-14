import { describe, expect, test } from "bun:test";
import { codex } from "./codex.js";

describe("codex adapter", () => {
	test("binary is codex", () => {
		expect(codex.binary).toBe("codex");
	});

	test("builds basic command with --full-auto", () => {
		const cmd = codex.buildCommand({
			prompt: "fix the bug",
			workdir: "/tmp",
		});
		expect(cmd).toEqual(["--full-auto", "fix the bug"]);
	});

	test("includes model flag", () => {
		const cmd = codex.buildCommand({
			prompt: "fix the bug",
			model: "gpt-4",
			workdir: "/tmp",
		});
		expect(cmd).toEqual(["--full-auto", "--model", "gpt-4", "fix the bug"]);
	});
});
