import { describe, expect, test } from "bun:test";
import { claudeCode } from "./claude-code.js";

describe("claude-code adapter", () => {
	test("binary is claude", () => {
		expect(claudeCode.binary).toBe("claude");
	});

	test("builds basic command with --print and --dangerously-skip-permissions", () => {
		const cmd = claudeCode.buildCommand({
			prompt: "fix the bug",
			workdir: "/tmp",
		});
		expect(cmd).toEqual(["--print", "--dangerously-skip-permissions", "fix the bug"]);
	});

	test("includes model flag", () => {
		const cmd = claudeCode.buildCommand({
			prompt: "fix the bug",
			model: "claude-sonnet-4",
			workdir: "/tmp",
		});
		expect(cmd).toEqual([
			"--print",
			"--dangerously-skip-permissions",
			"--model",
			"claude-sonnet-4",
			"fix the bug",
		]);
	});

	test("includes system prompt flag", () => {
		const cmd = claudeCode.buildCommand({
			prompt: "fix the bug",
			systemPrompt: "You are a helper",
			workdir: "/tmp",
		});
		expect(cmd).toEqual([
			"--print",
			"--dangerously-skip-permissions",
			"--append-system-prompt",
			"You are a helper",
			"fix the bug",
		]);
	});

	test("parses token usage", () => {
		const output = "Total cost: $0.05 | Input: 15.2k | Output: 3.4k";
		const usage = claudeCode.parseUsage?.(output);
		expect(usage).toEqual({ input: 15200, output: 3400 });
	});

	test("returns null for unparseable output", () => {
		const usage = claudeCode.parseUsage?.("no usage info here");
		expect(usage).toBeNull();
	});
});
