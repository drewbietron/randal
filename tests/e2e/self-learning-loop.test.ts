import { describe, expect, test } from "bun:test";
import {
	MemoryAnnotationStore,
	computeReliabilityScores,
	generateFeedback,
	generateRecommendations,
} from "@randal/analytics";
import type { Annotation } from "@randal/core";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
	return {
		id: `ann-${Math.random().toString(36).slice(2, 10)}`,
		jobId: `job-${Math.random().toString(36).slice(2, 10)}`,
		verdict: "pass",
		agent: "opencode",
		model: "anthropic/claude-sonnet-4",
		domain: "backend",
		iterationCount: 3,
		tokenCost: 15000,
		duration: 120,
		filesChanged: ["src/index.ts"],
		prompt: "build the API",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

describe("self-learning loop E2E", () => {
	test("full annotation → scoring → recommendations → feedback pipeline", async () => {
		const store = new MemoryAnnotationStore();
		const annotations: Annotation[] = [];

		// Submit 10 annotations with mixed verdicts: 6 pass, 3 fail, 1 partial
		const verdicts: Array<"pass" | "fail" | "partial"> = [
			"pass",
			"pass",
			"pass",
			"pass",
			"pass",
			"pass",
			"fail",
			"fail",
			"fail",
			"partial",
		];

		for (let i = 0; i < 10; i++) {
			const ann = makeAnnotation({
				id: `ann-${i}`,
				jobId: `job-${i}`,
				verdict: verdicts[i],
				agent: i % 2 === 0 ? "opencode" : "mock",
				model: i % 3 === 0 ? "anthropic/claude-sonnet-4" : "anthropic/claude-haiku-3.5",
				domain: i < 4 ? "frontend" : i < 7 ? "backend" : "testing",
				iterationCount: i + 1,
				feedback: verdicts[i] === "fail" ? `Failed on step ${i}` : undefined,
			});
			annotations.push(ann);
			await store.save(ann);
		}

		// Verify store count
		expect(await store.count()).toBe(10);

		// Compute scores
		const { scores, insufficientData } = computeReliabilityScores(annotations);

		// With 10 annotations, we hit the minimum threshold
		expect(insufficientData).toBe(false);
		expect(scores.length).toBeGreaterThan(0);

		// Verify overall pass rate is approximately 60%
		const overall = scores.find((s) => s.dimension === "overall");
		expect(overall).toBeDefined();
		if (overall) {
			// Weighted pass rate may differ slightly from raw 60%, but should be close
			expect(overall.passCount).toBe(6);
			expect(overall.failCount).toBe(3);
			expect(overall.partialCount).toBe(1);
			expect(overall.totalAnnotations).toBe(10);
			// Raw pass rate would be ~0.6, weighted may vary slightly due to aging
			expect(overall.passRate).toBeGreaterThan(0.4);
			expect(overall.passRate).toBeLessThan(0.8);
		}

		// Generate recommendations
		const recommendations = generateRecommendations(scores, annotations);
		expect(Array.isArray(recommendations)).toBe(true);
		// With mixed success rates, we may get at least one recommendation
		// (depends on data distribution meeting thresholds)

		// Generate feedback for a domain with low pass rate
		// Frontend has 4 annotations: verdicts[0..3] = pass,pass,pass,pass → all pass
		// Backend has 3 annotations: verdicts[4..6] = pass,pass,fail → mixed
		// Testing has 3 annotations: verdicts[7..9] = fail,fail,partial → low pass
		const testingFeedback = generateFeedback(scores, annotations, "testing");
		// Testing domain has 0 passes out of 3 → very low rate
		// But the minimum per-domain annotations is 5, so feedback may be empty
		// Test the function doesn't crash and returns a string
		expect(typeof testingFeedback).toBe("string");

		// Verify the overall pipeline completed without errors
		const allAnnotations = await store.list();
		expect(allAnnotations).toHaveLength(10);

		// Verify filtering works
		const failedOnly = await store.list({ verdict: "fail" });
		expect(failedOnly).toHaveLength(3);
	});

	test("insufficient data returns empty scores", async () => {
		const annotations: Annotation[] = [];

		for (let i = 0; i < 5; i++) {
			annotations.push(makeAnnotation({ id: `ann-${i}`, verdict: "pass" }));
		}

		const { scores, insufficientData } = computeReliabilityScores(annotations);
		expect(insufficientData).toBe(true);
		expect(scores).toHaveLength(0);

		// Recommendations with insufficient data should be empty
		const recommendations = generateRecommendations([], annotations);
		expect(recommendations).toHaveLength(0);
	});
});
