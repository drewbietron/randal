import { describe, expect, test } from "bun:test";
import type { DelegationResult, JobIteration, JobPlanTask } from "@randal/core";
import { compactContext, shouldCompact } from "./compaction.js";

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

function makePlanTask(overrides: Partial<JobPlanTask> = {}): JobPlanTask {
	return {
		task: "Implement feature",
		status: "pending",
		...overrides,
	};
}

function makeDelegation(overrides: Partial<DelegationResult> = {}): DelegationResult {
	return {
		jobId: "job-1",
		task: "Write tests",
		status: "complete",
		summary: "All tests pass",
		filesChanged: ["test.ts"],
		duration: 30,
		...overrides,
	};
}

const defaultConfig = {
	enabled: true,
	threshold: 0.8,
	model: "test-model",
	maxSummaryTokens: 10000,
};

// ── shouldCompact ───────────────────────────────────────────

describe("shouldCompact", () => {
	test("returns true when threshold exceeded", () => {
		// threshold = 0.8, maxContextWindow = 10000, triggerAt = 8000
		expect(shouldCompact(9000, 0.8, 10000)).toBe(true);
	});

	test("returns false when under threshold", () => {
		expect(shouldCompact(5000, 0.8, 10000)).toBe(false);
	});

	test("returns true when exactly at threshold", () => {
		// triggerAt = Math.floor(0.8 * 10000) = 8000
		expect(shouldCompact(8000, 0.8, 10000)).toBe(true);
	});

	test("returns false when maxContextWindow is zero", () => {
		expect(shouldCompact(5000, 0.8, 0)).toBe(false);
	});

	test("returns false when maxContextWindow is negative", () => {
		expect(shouldCompact(5000, 0.8, -1)).toBe(false);
	});

	test("returns true when contextLength equals maxContextWindow", () => {
		expect(shouldCompact(10000, 0.8, 10000)).toBe(true);
	});

	test("handles threshold of 1.0", () => {
		// triggerAt = 10000
		expect(shouldCompact(10000, 1.0, 10000)).toBe(true);
		expect(shouldCompact(9999, 1.0, 10000)).toBe(false);
	});

	test("handles very small threshold", () => {
		// threshold = 0.1, maxContextWindow = 10000, triggerAt = 1000
		expect(shouldCompact(1000, 0.1, 10000)).toBe(true);
		expect(shouldCompact(999, 0.1, 10000)).toBe(false);
	});
});

// ── compactContext ──────────────────────────────────────────

describe("compactContext", () => {
	test("returns original context when 2 or fewer iterations", () => {
		const iterations = [makeIteration({ number: 1 }), makeIteration({ number: 2 })];
		const plan = [makePlanTask()];

		const result = compactContext({
			iterations,
			plan,
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.iterationsCompacted).toBe(0);
		expect(result.originalTokens).toBe(result.compactedTokens);
		expect(result.compactedContext).toContain("Iteration 1");
		expect(result.compactedContext).toContain("Iteration 2");
	});

	test("returns original context for single iteration", () => {
		const result = compactContext({
			iterations: [makeIteration({ number: 1 })],
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.iterationsCompacted).toBe(0);
	});

	test("returns original context for empty iterations", () => {
		const result = compactContext({
			iterations: [],
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.iterationsCompacted).toBe(0);
		expect(result.compactedContext).toContain("No plan established");
	});

	test("preserves plan state in compacted output", () => {
		const plan = [
			makePlanTask({ task: "Set up database", status: "completed" }),
			makePlanTask({ task: "Implement API", status: "in_progress" }),
			makePlanTask({ task: "Write tests", status: "pending" }),
		];
		const iterations = [
			makeIteration({ number: 1 }),
			makeIteration({ number: 2 }),
			makeIteration({ number: 3 }),
		];

		const result = compactContext({
			iterations,
			plan,
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("Current Plan");
		expect(result.compactedContext).toContain("[x] Set up database");
		expect(result.compactedContext).toContain("[~] Implement API");
		expect(result.compactedContext).toContain("[ ] Write tests");
	});

	test("preserves most recent 2 iterations in full", () => {
		const iterations = [
			makeIteration({ number: 1, summary: "first iteration" }),
			makeIteration({ number: 2, summary: "second iteration" }),
			makeIteration({ number: 3, summary: "third iteration" }),
			makeIteration({ number: 4, summary: "fourth iteration" }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		// Iterations 3 and 4 should be kept in full (## Iteration N format)
		expect(result.compactedContext).toContain("## Iteration 3");
		expect(result.compactedContext).toContain("## Iteration 4");
		expect(result.compactedContext).toContain("third iteration");
		expect(result.compactedContext).toContain("fourth iteration");

		// Iterations 1 and 2 should be compacted (not full format)
		expect(result.compactedContext).not.toContain("## Iteration 1");
		expect(result.compactedContext).not.toContain("## Iteration 2");

		expect(result.iterationsCompacted).toBe(2);
	});

	test("summarizes older iterations with key details", () => {
		const iterations = [
			makeIteration({
				number: 1,
				summary: "set up project",
				filesChanged: ["package.json", "tsconfig.json"],
				exitCode: 0,
			}),
			makeIteration({
				number: 2,
				summary: "implemented auth",
				filesChanged: ["src/auth.ts"],
				exitCode: 0,
			}),
			makeIteration({ number: 3, summary: "recent work" }),
			makeIteration({ number: 4, summary: "latest work" }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		// The compacted history should mention older iteration summaries
		expect(result.compactedContext).toContain("Compacted History");
		expect(result.compactedContext).toContain("Iteration 1:");
		expect(result.compactedContext).toContain("set up project");
		expect(result.compactedContext).toContain("Iteration 2:");
		expect(result.compactedContext).toContain("implemented auth");
	});

	test("truncates file list when more than 3 files", () => {
		const iterations = [
			makeIteration({
				number: 1,
				filesChanged: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
			}),
			makeIteration({ number: 2 }),
			makeIteration({ number: 3 }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("(+2 more)");
	});

	test("includes plan task completion count in summary", () => {
		const iterations = [
			makeIteration({
				number: 1,
				planUpdate: [
					makePlanTask({ task: "Task A", status: "completed" }),
					makePlanTask({ task: "Task B", status: "completed" }),
				],
			}),
			makeIteration({ number: 2 }),
			makeIteration({ number: 3 }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("Completed 2 plan task(s)");
	});

	test("includes delegation count in summary", () => {
		const iterations = [
			makeIteration({
				number: 1,
				delegationRequests: [{ task: "Sub-task A" }, { task: "Sub-task B" }],
			}),
			makeIteration({ number: 2 }),
			makeIteration({ number: 3 }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("Delegated 2 task(s)");
	});

	test("preserves delegation results", () => {
		const delegations = [
			makeDelegation({
				jobId: "sub-1",
				task: "Write unit tests",
				status: "complete",
				summary: "All 15 tests pass",
			}),
		];
		const iterations = [
			makeIteration({ number: 1 }),
			makeIteration({ number: 2 }),
			makeIteration({ number: 3 }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations,
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("Delegation Results");
		expect(result.compactedContext).toContain("Write unit tests");
		expect(result.compactedContext).toContain("sub-1");
		expect(result.compactedContext).toContain("All 15 tests pass");
	});

	test("preserves human-injected context", () => {
		const injectedContext = [
			"User said: focus on error handling",
			"Priority: fix the login bug first",
		];
		const iterations = [
			makeIteration({ number: 1 }),
			makeIteration({ number: 2 }),
			makeIteration({ number: 3 }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			injectedContext,
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("Injected Context");
		expect(result.compactedContext).toContain("focus on error handling");
		expect(result.compactedContext).toContain("fix the login bug first");
	});

	test("sorts iterations by number", () => {
		const iterations = [
			makeIteration({ number: 3, summary: "third" }),
			makeIteration({ number: 1, summary: "first" }),
			makeIteration({ number: 4, summary: "fourth" }),
			makeIteration({ number: 2, summary: "second" }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		// Recent 2 (iterations 3 and 4) should be in full format
		expect(result.compactedContext).toContain("## Iteration 3");
		expect(result.compactedContext).toContain("## Iteration 4");
		// Older 2 (iterations 1 and 2) should be summarized
		expect(result.compactedContext).toContain("Iteration 1:");
		expect(result.compactedContext).toContain("Iteration 2:");
		expect(result.iterationsCompacted).toBe(2);
	});

	test("compactedTokens is less than or equal to originalTokens", () => {
		const iterations = Array.from({ length: 10 }, (_, i) =>
			makeIteration({
				number: i + 1,
				summary: `Iteration ${i + 1}: did a lot of work on feature ${i}. ${Array(50).fill("context").join(" ")}`,
				filesChanged: [`src/file${i}.ts`, `src/test${i}.ts`],
			}),
		);

		const result = compactContext({
			iterations,
			plan: [makePlanTask()],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.iterationsCompacted).toBe(8);
		expect(result.compactedTokens).toBeLessThanOrEqual(result.originalTokens);
	});

	test("includes progress notes in iteration summary", () => {
		const iterations = [
			makeIteration({
				number: 1,
				progress: "Halfway through API implementation",
			}),
			makeIteration({ number: 2 }),
			makeIteration({ number: 3 }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("Halfway through API implementation");
	});

	test("shows exit code for iterations without summary", () => {
		const iterations = [
			makeIteration({
				number: 1,
				summary: "",
				exitCode: 1,
			}),
			makeIteration({ number: 2 }),
			makeIteration({ number: 3 }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("Exited with code 1");
	});

	test("handles failed plan status icon", () => {
		const plan = [makePlanTask({ task: "Broken task", status: "failed" })];
		const result = compactContext({
			iterations: [makeIteration({ number: 1 })],
			plan,
			delegations: [],
			compactionConfig: defaultConfig,
		});

		expect(result.compactedContext).toContain("[!] Broken task");
	});

	test("truncates older summary when exceeding maxSummaryTokens", () => {
		// Create iterations with very long summaries to exceed a small maxSummaryTokens
		const iterations = Array.from({ length: 6 }, (_, i) =>
			makeIteration({
				number: i + 1,
				summary: `Iteration ${i + 1}: ${Array(200).fill("detailed context about the work performed").join(" ")}`,
				filesChanged: Array.from({ length: 5 }, (_, j) => `src/module${i}/file${j}.ts`),
				tokens: { input: 5000, output: 1200 },
				progress: `Progress for iteration ${i + 1}: ${Array(50).fill("progress note").join(" ")}`,
			}),
		);

		const result = compactContext({
			iterations,
			plan: [makePlanTask()],
			delegations: [],
			compactionConfig: {
				enabled: true,
				threshold: 0.8,
				model: "unused",
				maxSummaryTokens: 500, // Very small budget to force truncation
			},
		});

		// Should have compacted 4 older iterations (6 - 2 recent)
		expect(result.iterationsCompacted).toBe(4);
		// The compacted output should contain truncation marker
		expect(result.compactedContext).toContain("(truncated)");
		// Compacted tokens should be less than or equal to original
		expect(result.compactedTokens).toBeLessThanOrEqual(result.originalTokens);
	});
});

// ── compaction integration ──────────────────────────────────

describe("compaction integration", () => {
	test("shouldCompact triggers compaction that reduces context size", () => {
		// Create enough iterations to trigger compaction
		const iterations = Array.from({ length: 8 }, (_, i) =>
			makeIteration({
				number: i + 1,
				summary: `Iteration ${i + 1}: performed extensive work. ${Array(100).fill("word").join(" ")}`,
				filesChanged: [`src/file${i}.ts`, `src/test${i}.ts`, `src/helper${i}.ts`],
				tokens: { input: 10000, output: 3000 },
			}),
		);

		// Estimate total tokens (rough: sum of input+output across iterations)
		const estimatedTokens = iterations.reduce(
			(sum, iter) => sum + iter.tokens.input + iter.tokens.output,
			0,
		);

		const maxContextWindow = 128000;
		const threshold = 0.8;

		// Verify threshold is reached (104000 >= 102400)
		expect(shouldCompact(estimatedTokens, threshold, maxContextWindow)).toBe(true);

		// Run compaction
		const result = compactContext({
			iterations,
			plan: [makePlanTask({ task: "Build feature", status: "in_progress" })],
			delegations: [],
			compactionConfig: {
				enabled: true,
				threshold,
				model: "unused",
				maxSummaryTokens: 10000,
			},
		});

		// Verify compaction occurred and reduced size
		expect(result.iterationsCompacted).toBe(6); // 8 - 2 recent
		expect(result.compactedTokens).toBeLessThan(result.originalTokens);
		// Verify recent iterations are preserved in full
		expect(result.compactedContext).toContain("## Iteration 7");
		expect(result.compactedContext).toContain("## Iteration 8");
		// Verify older iterations are summarized (not in full format)
		expect(result.compactedContext).not.toContain("## Iteration 1");
		expect(result.compactedContext).toContain("Compacted History");
	});

	test("shouldCompact returns false when under threshold — no compaction needed", () => {
		const iterations = [
			makeIteration({ number: 1, tokens: { input: 1000, output: 200 } }),
			makeIteration({ number: 2, tokens: { input: 1000, output: 200 } }),
			makeIteration({ number: 3, tokens: { input: 1000, output: 200 } }),
		];

		const estimatedTokens = iterations.reduce(
			(sum, iter) => sum + iter.tokens.input + iter.tokens.output,
			0,
		); // 3600

		expect(shouldCompact(estimatedTokens, 0.8, 128000)).toBe(false);
	});
});
