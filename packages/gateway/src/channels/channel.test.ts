import { describe, expect, test } from "bun:test";
import { splitMessage } from "./channel.js";

describe("splitMessage", () => {
	test("returns single chunk for short messages", () => {
		const result = splitMessage("hello", 100);
		expect(result).toEqual(["hello"]);
	});

	test("splits on newline boundaries", () => {
		const text = "line1\nline2\nline3";
		const result = splitMessage(text, 12);
		// "line1\nline2" = 11 chars, fits. Adding "\nline3" = 17, doesn't fit.
		expect(result).toEqual(["line1\nline2", "line3"]);
	});

	test("hard-splits lines exceeding max length", () => {
		const text = "a".repeat(200);
		const result = splitMessage(text, 100);
		expect(result.length).toBe(2);
		expect(result[0].length).toBe(100);
		expect(result[1].length).toBe(100);
	});

	test("handles empty string", () => {
		const result = splitMessage("", 100);
		expect(result).toEqual([""]);
	});

	test("handles exact max length", () => {
		const text = "a".repeat(100);
		const result = splitMessage(text, 100);
		expect(result).toEqual([text]);
	});

	test("handles multiple newline-boundary splits", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
		const text = lines.join("\n");
		// Each "lineN" is 5 chars. With newlines: "line0\nline1" = 11 chars
		const result = splitMessage(text, 15);
		// Should group lines that fit within 15 chars
		expect(result.length).toBeGreaterThan(1);
		for (const chunk of result) {
			expect(chunk.length).toBeLessThanOrEqual(15);
		}
	});

	test("handles mixed short and long lines", () => {
		const text = `short\n${"x".repeat(200)}\nshort`;
		const result = splitMessage(text, 100);
		// "short" fits, then long line gets hard-split, then "short" fits
		expect(result.length).toBeGreaterThan(2);
		expect(result[0]).toBe("short");
		expect(result[result.length - 1]).toBe("short");
	});
});
