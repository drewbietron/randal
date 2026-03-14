import { describe, expect, test } from "bun:test";
import { formatHelp, parseCommand } from "./router.js";

describe("parseCommand", () => {
	test("parses run command", () => {
		const result = parseCommand("run: fix the auth bug");
		expect(result).toEqual({ command: "run", args: "fix the auth bug" });
	});

	test("parses status command bare", () => {
		expect(parseCommand("status")).toEqual({ command: "status", args: "" });
	});

	test("parses status with id", () => {
		expect(parseCommand("status: abc123")).toEqual({
			command: "status",
			args: "abc123",
		});
	});

	test("parses stop command", () => {
		expect(parseCommand("stop: abc123")).toEqual({
			command: "stop",
			args: "abc123",
		});
	});

	test("parses context command", () => {
		expect(parseCommand("context: focus on error handling")).toEqual({
			command: "context",
			args: "focus on error handling",
		});
	});

	test("parses jobs bare", () => {
		expect(parseCommand("jobs")).toEqual({ command: "jobs", args: "" });
	});

	test("parses memory search", () => {
		expect(parseCommand("memory: supabase config")).toEqual({
			command: "memory",
			args: "supabase config",
		});
	});

	test("parses resume", () => {
		expect(parseCommand("resume: abc123")).toEqual({
			command: "resume",
			args: "abc123",
		});
	});

	test("parses help", () => {
		expect(parseCommand("help")).toEqual({ command: "help", args: "" });
	});

	test("returns null for non-command", () => {
		expect(parseCommand("just a regular message")).toBeNull();
	});

	test("is case-insensitive", () => {
		expect(parseCommand("RUN: do something")).toEqual({
			command: "run",
			args: "do something",
		});
	});

	test("handles extra whitespace", () => {
		expect(parseCommand("  run:  do something  ")).toEqual({
			command: "run",
			args: "do something",
		});
	});
});

describe("formatHelp", () => {
	test("contains all commands", () => {
		const help = formatHelp();
		expect(help).toContain("run:");
		expect(help).toContain("status");
		expect(help).toContain("stop");
		expect(help).toContain("context:");
		expect(help).toContain("jobs");
		expect(help).toContain("memory:");
		expect(help).toContain("resume:");
		expect(help).toContain("help");
	});
});
