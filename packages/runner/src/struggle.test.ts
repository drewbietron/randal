import { describe, expect, test } from "bun:test";
import type { JobIteration } from "@randal/core";
import { detectFatalError, detectStruggle } from "./struggle.js";

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

describe("detectFatalError", () => {
	test("detects 'not logged in' in output", () => {
		const result = detectFatalError("Error: Not logged in. Please run /login to authenticate.");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Agent is not logged in");
	});

	test("detects 'please run /login' in output", () => {
		const result = detectFatalError("please run /login");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Agent is not logged in");
	});

	test("detects login required in stderr", () => {
		const result = detectFatalError("", "authentication required");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Agent is not logged in");
	});

	test("detects invalid API key", () => {
		const result = detectFatalError("Error: API key is invalid. Check your credentials.");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("API key is invalid or missing");
	});

	test("detects expired API key", () => {
		const result = detectFatalError("Your API key has expired");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("API key is invalid or missing");
	});

	test("detects missing API key", () => {
		const result = detectFatalError("API key not set");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("API key is invalid or missing");
	});

	test("detects rate limit exceeded", () => {
		const result = detectFatalError("Error: Rate limit exceeded. Try again later.");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Rate limit or quota exceeded");
	});

	test("detects quota exceeded", () => {
		const result = detectFatalError("quota exceeded for this billing period");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Rate limit or quota exceeded");
	});

	test("detects permission denied", () => {
		const result = detectFatalError("permission denied: cannot access /workspace");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Permission denied");
	});

	test("detects billing issues", () => {
		const result = detectFatalError("billing issue: payment required to continue");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Billing issue");
	});

	test("detects model not found", () => {
		const result = detectFatalError("The model 'claude-opus-99' does not exist");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Model not available");
	});

	test("detects model may not exist or no access", () => {
		const result = detectFatalError("There's an issue with the selected model (anthropic/claude-sonnet-4). It may not exist or you may not have access to it.");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Model not available");
	});

	test("returns not fatal for normal output", () => {
		const result = detectFatalError("Created file src/index.ts\nModified package.json");
		expect(result.isFatal).toBe(false);
		expect(result.error).toBeNull();
	});

	test("returns not fatal for empty output", () => {
		const result = detectFatalError("");
		expect(result.isFatal).toBe(false);
		expect(result.error).toBeNull();
	});

	test("returns not fatal for normal error output", () => {
		const result = detectFatalError("", "TypeScript error: Cannot find module");
		expect(result.isFatal).toBe(false);
		expect(result.error).toBeNull();
	});

	test("checks stderr when output is clean", () => {
		const result = detectFatalError("normal output here", "not logged in");
		expect(result.isFatal).toBe(true);
		expect(result.error).toBe("Agent is not logged in");
	});
});
