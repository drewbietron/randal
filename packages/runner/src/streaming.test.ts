import { describe, expect, test } from "bun:test";
import type { ToolUseEvent } from "@randal/core";
import { readStream, readStreamLines } from "./streaming.js";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

// ── readStreamLines ─────────────────────────────────────────

describe("readStreamLines", () => {
	test("returns empty result for null stream", async () => {
		const result = await readStreamLines(null);
		expect(result.output).toBe("");
		expect(result.toolUses).toHaveLength(0);
		expect(result.lineCount).toBe(0);
	});

	test("returns empty result for empty stream", async () => {
		const stream = makeStream([]);
		const result = await readStreamLines(stream);
		expect(result.output).toBe("");
		expect(result.toolUses).toHaveLength(0);
		expect(result.lineCount).toBe(0);
	});

	test("processes lines and calls onLine callback", async () => {
		const stream = makeStream(["line1\nline2\nline3\n"]);
		const lines: string[] = [];

		const result = await readStreamLines(stream, {
			onLine: (line) => lines.push(line),
			maxEventsPerSecond: Number.POSITIVE_INFINITY, // disable rate limiting
		});

		expect(result.lineCount).toBe(3);
		expect(result.output).toBe("line1\nline2\nline3\n");
		expect(lines).toContain("line1");
		expect(lines).toContain("line2");
		expect(lines).toContain("line3");
	});

	test("handles partial line buffering across chunks", async () => {
		const stream = makeStream(["hel", "lo\nwor", "ld\n"]);
		const lines: string[] = [];

		const result = await readStreamLines(stream, {
			onLine: (line) => lines.push(line),
			maxEventsPerSecond: Number.POSITIVE_INFINITY,
		});

		expect(result.lineCount).toBe(2);
		expect(lines).toContain("hello");
		expect(lines).toContain("world");
	});

	test("processes trailing partial line without newline", async () => {
		const stream = makeStream(["complete\npartial"]);
		const lines: string[] = [];

		const result = await readStreamLines(stream, {
			onLine: (line) => lines.push(line),
			maxEventsPerSecond: Number.POSITIVE_INFINITY,
		});

		expect(result.lineCount).toBe(2);
		expect(lines).toContain("complete");
		expect(lines).toContain("partial");
	});

	test("detects tool uses via parseToolUse callback", async () => {
		const stream = makeStream(["normal line\n[tool:write] file.ts\n"]);

		const result = await readStreamLines(stream, {
			parseToolUse: (line) => {
				const m = line.match(/^\[tool:(\w+)\]\s*(.*)$/);
				if (m) return { tool: m[1], args: m[2] };
				return null;
			},
		});

		expect(result.toolUses).toHaveLength(1);
		expect(result.toolUses[0].tool).toBe("write");
		expect(result.toolUses[0].args).toBe("file.ts");
	});

	test("calls onToolUse callback for detected tool uses", async () => {
		const stream = makeStream(["[tool:read] src/main.ts\n"]);
		const toolEvents: ToolUseEvent[] = [];

		await readStreamLines(stream, {
			parseToolUse: (line) => {
				if (line.startsWith("[tool:")) return { tool: "read", args: "src/main.ts" };
				return null;
			},
			onToolUse: (event) => toolEvents.push(event),
		});

		expect(toolEvents).toHaveLength(1);
		expect(toolEvents[0].tool).toBe("read");
	});

	test("tool use detection is not rate limited", async () => {
		// All tool use lines should be detected even with aggressive rate limiting
		const lines = Array.from({ length: 20 }, (_, i) => `[tool:run] cmd${i}\n`);
		const stream = makeStream([lines.join("")]);
		const toolEvents: ToolUseEvent[] = [];

		const result = await readStreamLines(stream, {
			parseToolUse: (line) => {
				const m = line.match(/^\[tool:(\w+)\]\s*(.*)$/);
				if (m) return { tool: m[1], args: m[2] };
				return null;
			},
			onToolUse: (event) => toolEvents.push(event),
			maxEventsPerSecond: 1, // very aggressive rate limiting
		});

		// All 20 tool uses should be detected
		expect(result.toolUses).toHaveLength(20);
		expect(toolEvents).toHaveLength(20);
	});

	test("rate limits onLine callbacks", async () => {
		// With maxEventsPerSecond = 1, only the first line in a fast burst should trigger onLine
		const lines = Array.from({ length: 10 }, (_, i) => `line${i}\n`);
		const stream = makeStream([lines.join("")]);
		const receivedLines: string[] = [];

		await readStreamLines(stream, {
			onLine: (line) => receivedLines.push(line),
			maxEventsPerSecond: 1,
		});

		// Due to rate limiting, not all 10 lines should be emitted
		expect(receivedLines.length).toBeLessThan(10);
		expect(receivedLines.length).toBeGreaterThanOrEqual(1);
	});

	test("collects full output from chunks", async () => {
		const stream = makeStream(["abc", "def", "ghi"]);
		const result = await readStreamLines(stream);

		// Output is the raw joined chunks
		expect(result.output).toBe("abcdefghi");
	});

	test("handles single line without newline", async () => {
		const stream = makeStream(["only-line"]);
		const result = await readStreamLines(stream);

		expect(result.lineCount).toBe(1);
		expect(result.output).toBe("only-line");
	});

	test("handles multiple empty lines", async () => {
		const stream = makeStream(["\n\n\n"]);
		const lines: string[] = [];

		const result = await readStreamLines(stream, {
			onLine: (line) => lines.push(line),
			maxEventsPerSecond: Number.POSITIVE_INFINITY,
		});

		expect(result.lineCount).toBe(3);
	});
});

// ── readStream ──────────────────────────────────────────────

describe("readStream", () => {
	test("returns empty string for null stream", async () => {
		const result = await readStream(null);
		expect(result).toBe("");
	});

	test("reads full stream content in batch mode", async () => {
		const stream = makeStream(["hello ", "world"]);
		const result = await readStream(stream);
		expect(result).toBe("hello world");
	});

	test("handles empty stream", async () => {
		const stream = makeStream([]);
		const result = await readStream(stream);
		expect(result).toBe("");
	});

	test("handles multi-line content", async () => {
		const stream = makeStream(["line1\nline2\n", "line3\n"]);
		const result = await readStream(stream);
		expect(result).toBe("line1\nline2\nline3\n");
	});
});
