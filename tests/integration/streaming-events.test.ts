import { describe, expect, test } from "bun:test";
import type { ToolUseEvent } from "@randal/core";
import { readStreamLines } from "@randal/runner";

/**
 * Create a mock ReadableStream from an array of line strings.
 * Each line is emitted as its own chunk (with a trailing newline),
 * with a microtask yield between to simulate real streaming.
 */
function createMockStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		async pull(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(`${line}\n`));
				// Yield to simulate async chunking
				await new Promise((r) => setTimeout(r, 0));
			}
			controller.close();
		},
	});
}

describe("streaming events integration", () => {
	test("readStreamLines detects tool use events in real-time", async () => {
		const lines = [
			"Starting task...",
			"Analyzing codebase...",
			'[tool_use] {"tool":"Read","args":"src/index.ts"}',
			"Reading file content...",
			'[tool_use] {"tool":"Write","args":"src/new.ts"}',
			"Task complete.",
		];

		const stream = createMockStream(lines);
		const detectedToolUses: ToolUseEvent[] = [];
		const allLines: string[] = [];

		const result = await readStreamLines(stream, {
			onLine: (line) => allLines.push(line),
			onToolUse: (event) => detectedToolUses.push(event),
			parseToolUse: (line) => {
				const match = line.match(/\[tool_use\]\s*({.*})/);
				if (!match) return null;
				try {
					return JSON.parse(match[1]) as ToolUseEvent;
				} catch {
					return null;
				}
			},
			maxEventsPerSecond: 10000, // Very high rate for testing
		});

		// Verify tool uses were detected
		expect(detectedToolUses).toHaveLength(2);
		expect(detectedToolUses[0].tool).toBe("Read");
		expect(detectedToolUses[1].tool).toBe("Write");

		// Verify output is collected
		expect(result.output).toContain("Starting task...");
		expect(result.output).toContain("Task complete.");
		expect(result.toolUses).toHaveLength(2);
		expect(result.lineCount).toBeGreaterThanOrEqual(6);
	});

	test("readStreamLines handles empty stream", async () => {
		const result = await readStreamLines(null);
		expect(result.output).toBe("");
		expect(result.toolUses).toHaveLength(0);
		expect(result.lineCount).toBe(0);
	});

	test("readStreamLines collects output correctly from chunked stream", async () => {
		const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: ${"x".repeat(20)}`);
		const stream = createMockStream(lines);

		const result = await readStreamLines(stream, {
			maxEventsPerSecond: 10000,
		});

		expect(result.lineCount).toBe(50);
		expect(result.output).toContain("Line 1:");
		expect(result.output).toContain("Line 50:");
	});
});
