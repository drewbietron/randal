import { describe, expect, test } from "bun:test";
import type { JobIteration, JobPlanTask } from "@randal/core";
import { compactContext, shouldCompact } from "@randal/runner";

function makeIteration(overrides: Partial<JobIteration> = {}): JobIteration {
	return {
		number: 1,
		startedAt: new Date().toISOString(),
		duration: 60000,
		filesChanged: ["src/index.ts"],
		tokens: { input: 5000, output: 1200 },
		exitCode: 0,
		promiseFound: false,
		summary: "Working on feature implementation",
		...overrides,
	};
}

describe("compaction integration", () => {
	test("shouldCompact triggers at threshold", () => {
		const maxContextWindow = 100000;
		const threshold = 0.7; // 70%

		// Below threshold — should not compact
		expect(shouldCompact(50000, threshold, maxContextWindow)).toBe(false);

		// At threshold — should compact
		expect(shouldCompact(70000, threshold, maxContextWindow)).toBe(true);

		// Above threshold — should compact
		expect(shouldCompact(90000, threshold, maxContextWindow)).toBe(true);
	});

	test("shouldCompact returns false for zero maxContextWindow", () => {
		expect(shouldCompact(1000, 0.7, 0)).toBe(false);
	});

	test("compactContext with 10+ iterations", () => {
		const iterations: JobIteration[] = [];
		for (let i = 1; i <= 10; i++) {
			iterations.push(
				makeIteration({
					number: i,
					summary: `Iteration ${i}: implemented feature part ${i}`,
					filesChanged: [`src/part${i}.ts`],
					tokens: { input: 3000 + i * 100, output: 800 + i * 50 },
				}),
			);
		}

		const plan: JobPlanTask[] = [
			{ task: "Set up project structure", status: "completed" },
			{ task: "Implement core logic", status: "completed" },
			{ task: "Add tests", status: "in_progress" },
			{ task: "Write documentation", status: "pending" },
		];

		const result = compactContext({
			iterations,
			plan,
			delegations: [],
			compactionConfig: {
				enabled: true,
				threshold: 0.7,
				model: "anthropic/claude-sonnet-4",
				maxSummaryTokens: 10000,
			},
		});

		// Should have compacted older iterations
		expect(result.iterationsCompacted).toBe(8); // 10 - 2 recent
		expect(result.compactedTokens).toBeLessThan(result.originalTokens);

		// Verify recent 2 iterations preserved in full
		const context = result.compactedContext;
		expect(context).toContain("## Iteration 9");
		expect(context).toContain("## Iteration 10");
		expect(context).toContain("Iteration 9:");
		expect(context).toContain("Iteration 10:");

		// Verify plan preserved
		expect(context).toContain("## Current Plan");
		expect(context).toContain("Set up project structure");
		expect(context).toContain("Add tests");

		// Verify older iterations summarized (not in full form)
		expect(context).toContain("Compacted History");
		// Iteration 1 should be in summary form, not full detail
		expect(context).toContain("Iteration 1:");
	});

	test("compactContext preserves delegations and injected context", () => {
		const iterations = Array.from({ length: 5 }, (_, i) =>
			makeIteration({
				number: i + 1,
				summary: `Did step ${i + 1}`,
			}),
		);

		const delegations = [
			{
				jobId: "sub-1",
				task: "Build the auth module",
				status: "complete" as const,
				summary: "Auth module built successfully",
				filesChanged: ["src/auth.ts"],
				duration: 30000,
			},
		];

		const injectedContext = ["User prefers TypeScript strict mode"];

		const result = compactContext({
			iterations,
			plan: [],
			delegations,
			injectedContext,
			compactionConfig: {
				enabled: true,
				threshold: 0.7,
				model: "anthropic/claude-sonnet-4",
				maxSummaryTokens: 10000,
			},
		});

		const context = result.compactedContext;

		// Delegations should be preserved
		expect(context).toContain("Delegation Results");
		expect(context).toContain("Build the auth module");

		// Injected context should be preserved
		expect(context).toContain("Injected Context");
		expect(context).toContain("TypeScript strict mode");
	});

	test("compactContext with fewer than 3 iterations does not compact", () => {
		const iterations = [
			makeIteration({ number: 1, summary: "First iteration" }),
			makeIteration({ number: 2, summary: "Second iteration" }),
		];

		const result = compactContext({
			iterations,
			plan: [],
			delegations: [],
			compactionConfig: {
				enabled: true,
				threshold: 0.7,
				model: "anthropic/claude-sonnet-4",
				maxSummaryTokens: 10000,
			},
		});

		expect(result.iterationsCompacted).toBe(0);
		expect(result.compactedTokens).toBe(result.originalTokens);
	});
});
