/**
 * StreamingReader — processes stdout from agent processes line-by-line
 * in real-time, emitting tool use events and output lines as they arrive.
 */

import type { ToolUseEvent } from "@randal/core";

export interface StreamingReaderOptions {
	/** Called for each complete line of output */
	onLine?: (line: string) => void;
	/** Called when a tool use is detected */
	onToolUse?: (event: ToolUseEvent) => void;
	/** Parse a line for tool use events (adapter-specific) */
	parseToolUse?: (line: string) => ToolUseEvent | null;
	/** Maximum events per second for output lines (default: 10) */
	maxEventsPerSecond?: number;
}

export interface StreamingResult {
	/** Full output collected */
	output: string;
	/** All tool use events detected */
	toolUses: ToolUseEvent[];
	/** Total lines processed */
	lineCount: number;
}

/**
 * Read a readable stream line-by-line, processing each line as it arrives.
 * Supports backpressure via rate limiting and partial line buffering.
 */
export async function readStreamLines(
	stream: ReadableStream<Uint8Array> | null,
	options: StreamingReaderOptions = {},
): Promise<StreamingResult> {
	if (!stream) {
		return { output: "", toolUses: [], lineCount: 0 };
	}

	const { onLine, onToolUse, parseToolUse, maxEventsPerSecond = 10 } = options;

	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	const toolUses: ToolUseEvent[] = [];
	let lineCount = 0;
	let partialLine = "";

	// Rate limiting for output events
	const minInterval = 1000 / maxEventsPerSecond;
	let lastEventTime = 0;

	function processLine(line: string): void {
		lineCount++;

		// Rate-limited line callback
		if (onLine) {
			const now = Date.now();
			if (now - lastEventTime >= minInterval) {
				onLine(line);
				lastEventTime = now;
			}
		}

		// Tool use detection (not rate-limited — these are important)
		if (parseToolUse) {
			const toolUse = parseToolUse(line);
			if (toolUse) {
				toolUses.push(toolUse);
				onToolUse?.(toolUse);
			}
		}
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const text = decoder.decode(value, { stream: true });
			chunks.push(text);

			// Split into lines, handling partial lines from previous chunk
			const combined = partialLine + text;
			const lines = combined.split("\n");

			// Last element is either empty (if text ended with \n) or a partial line
			partialLine = lines.pop() ?? "";

			for (const line of lines) {
				processLine(line);
			}
		}

		// Process any remaining partial line
		if (partialLine) {
			processLine(partialLine);
			partialLine = "";
		}
	} catch {
		// Stream ended or errored — process what we have
		if (partialLine) {
			processLine(partialLine);
		}
	} finally {
		reader.releaseLock();
	}

	return {
		output: chunks.join(""),
		toolUses,
		lineCount,
	};
}

/**
 * Read a readable stream to completion (batch mode, no line processing).
 * Used for stderr or when streaming is not needed.
 */
export async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(decoder.decode(value, { stream: true }));
		}
	} catch {
		// Stream ended or errored
	} finally {
		reader.releaseLock();
	}
	return chunks.join("");
}
