import { describe, expect, test } from "bun:test";
import {
	findCompletionPromise,
	generateToken,
	isStartMarker,
	parseDoneMarker,
	parseOutput,
	wrapCommand,
} from "./sentinel.js";

describe("sentinel", () => {
	describe("generateToken", () => {
		test("generates 8-char hex token", () => {
			const token = generateToken();
			expect(token).toMatch(/^[a-f0-9]{8}$/);
		});

		test("generates unique tokens", () => {
			const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
			expect(tokens.size).toBe(100);
		});
	});

	describe("wrapCommand", () => {
		test("wraps command with markers", () => {
			const { shell } = wrapCommand("abcd1234", "opencode", ["run", "fix the bug"]);
			expect(shell).toContain("__START_abcd1234");
			expect(shell).toContain("__DONE_abcd1234:$?");
			expect(shell).toContain("opencode");
		});

		test("escapes single quotes in args", () => {
			const { shell } = wrapCommand("abcd1234", "echo", ["it's a test"]);
			expect(shell).toContain("'it'\\''s a test'");
		});
	});

	describe("isStartMarker", () => {
		test("detects start marker", () => {
			expect(isStartMarker("__START_abcd1234", "abcd1234")).toBe(true);
		});

		test("handles whitespace", () => {
			expect(isStartMarker("  __START_abcd1234  ", "abcd1234")).toBe(true);
		});

		test("rejects non-matching", () => {
			expect(isStartMarker("__START_other", "abcd1234")).toBe(false);
		});
	});

	describe("parseDoneMarker", () => {
		test("extracts exit code 0", () => {
			const result = parseDoneMarker("__DONE_abcd1234:0", "abcd1234");
			expect(result).toEqual({ exitCode: 0 });
		});

		test("extracts non-zero exit code", () => {
			const result = parseDoneMarker("__DONE_abcd1234:127", "abcd1234");
			expect(result).toEqual({ exitCode: 127 });
		});

		test("handles whitespace", () => {
			const result = parseDoneMarker("  __DONE_abcd1234:0  ", "abcd1234");
			expect(result).toEqual({ exitCode: 0 });
		});

		test("returns null for non-matching", () => {
			expect(parseDoneMarker("random line", "abcd1234")).toBeNull();
		});

		test("returns null for invalid exit code", () => {
			expect(parseDoneMarker("__DONE_abcd1234:abc", "abcd1234")).toBeNull();
		});
	});

	describe("findCompletionPromise", () => {
		test("finds promise in output", () => {
			const output = "some output\n<promise>DONE</promise>\nmore output";
			expect(findCompletionPromise(output, "DONE")).toBe(true);
		});

		test("returns false when not found", () => {
			expect(findCompletionPromise("no promise here", "DONE")).toBe(false);
		});

		test("handles custom promise tags", () => {
			const output = "<promise>COMPLETE</promise>";
			expect(findCompletionPromise(output, "COMPLETE")).toBe(true);
			expect(findCompletionPromise(output, "DONE")).toBe(false);
		});
	});

	describe("parseOutput", () => {
		test("extracts output between markers", () => {
			const full = "__START_abcd1234\nhello world\n__DONE_abcd1234:0\n";
			const result = parseOutput(full, "abcd1234");
			expect(result).toEqual({ output: "hello world", exitCode: 0 });
		});

		test("returns null without start marker", () => {
			const full = "hello\n__DONE_abcd1234:0\n";
			expect(parseOutput(full, "abcd1234")).toBeNull();
		});

		test("returns null without done marker", () => {
			const full = "__START_abcd1234\nhello\n";
			expect(parseOutput(full, "abcd1234")).toBeNull();
		});

		test("handles multi-line output", () => {
			const full = "__START_abcd1234\nline1\nline2\nline3\n__DONE_abcd1234:0\n";
			const result = parseOutput(full, "abcd1234");
			expect(result?.output).toBe("line1\nline2\nline3");
			expect(result?.exitCode).toBe(0);
		});
	});
});
