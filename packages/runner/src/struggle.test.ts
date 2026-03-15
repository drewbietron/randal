import { describe, expect, test } from "bun:test";
import type { JobIteration } from "@randal/core";
import { detectStruggle } from "./struggle.js";

const defaultConfig = { noChangeThreshold: 3, maxRepeatedErrors: 3 };

function makeIteration(overrides: Partial<JobIteration> = {}): JobIteration {
	return {
		number: 1,
		startedAt: new Date().toISOString(),
		duration: 60,
		filesChanged: [],
		tokens: { input: 5000, output: 1200 },
		exitCode: 0,
		promiseFound: false,
		summary: "working on it",
		...overrides,
	};
}

describe("detectStruggle", () => {
	test("no struggle with few iterations", () => {
		const result = detectStruggle([makeIteration(), makeIteration()], defaultConfig);
		expect(result.isStuck).toBe(false);
		expect(result.indicators).toHaveLength(0);
	});

	test("detects no file changes", () => {
		const history = [
			makeIteration({ filesChanged: [] }),
			makeIteration({ filesChanged: [] }),
			makeIteration({ filesChanged: [] }),
		];
		const result = detectStruggle(history, defaultConfig);
		expect(result.isStuck).toBe(true);
		expect(result.indicators).toContain("No file changes for 3 iterations");
	});

	test("no false positive when files change", () => {
		const history = [
			makeIteration({ filesChanged: [] }),
			makeIteration({ filesChanged: ["src/a.ts"] }),
			makeIteration({ filesChanged: [] }),
		];
		const result = detectStruggle(history, defaultConfig);
		expect(result.indicators).not.toContain("No file changes for 3 iterations");
	});

	test("detects repeated errors", () => {
		const history = [
			makeIteration({ exitCode: 1 }),
			makeIteration({ exitCode: 1 }),
			makeIteration({ exitCode: 1 }),
		];
		const result = detectStruggle(history, defaultConfig);
		expect(result.isStuck).toBe(true);
		expect(result.indicators).toContain("Non-zero exit code for 3 consecutive iterations");
	});

	test("no false positive with mixed exit codes", () => {
		const history = [
			makeIteration({ exitCode: 1 }),
			makeIteration({ exitCode: 0 }),
			makeIteration({ exitCode: 1 }),
		];
		const result = detectStruggle(history, defaultConfig);
		expect(result.indicators).not.toContain("Non-zero exit code for 3 consecutive iterations");
	});

	test("detects identical summaries", () => {
		const history = [
			makeIteration({ summary: "stuck on auth", filesChanged: ["a.ts"] }),
			makeIteration({ summary: "stuck on auth", filesChanged: ["a.ts"] }),
			makeIteration({ summary: "stuck on auth", filesChanged: ["a.ts"] }),
		];
		const result = detectStruggle(history, defaultConfig);
		expect(result.isStuck).toBe(true);
		expect(result.indicators).toContain("Identical summary for 3 iterations");
	});

	test("can have multiple indicators", () => {
		const history = [
			makeIteration({ exitCode: 1, filesChanged: [], summary: "error" }),
			makeIteration({ exitCode: 1, filesChanged: [], summary: "error" }),
			makeIteration({ exitCode: 1, filesChanged: [], summary: "error" }),
		];
		const result = detectStruggle(history, defaultConfig);
		expect(result.isStuck).toBe(true);
		expect(result.indicators.length).toBeGreaterThanOrEqual(2);
	});
});
