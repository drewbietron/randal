import { describe, expect, test } from "bun:test";
import type { Annotation, ReliabilityScore } from "@randal/core";
import { generateFeedback } from "./feedback-injector.js";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
	return {
		id: `ann-${Math.random().toString(36).slice(2, 8)}`,
		jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
		verdict: "pass",
		agent: "opencode",
		model: "anthropic/claude-sonnet-4",
		domain: "backend",
		iterationCount: 3,
		tokenCost: 1000,
		duration: 60,
		filesChanged: ["src/index.ts"],
		prompt: "Build a REST API",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

function makeAnnotations(count: number, overrides: Partial<Annotation> = {}): Annotation[] {
	return Array.from({ length: count }, () => makeAnnotation(overrides));
}

function makeScore(overrides: Partial<ReliabilityScore> = {}): ReliabilityScore {
	return {
		dimension: "overall",
		value: "all",
		passRate: 0.8,
		totalAnnotations: 20,
		passCount: 16,
		failCount: 4,
		partialCount: 0,
		...overrides,
	};
}

describe("generateFeedback", () => {
	test("returns empty string for fewer than 10 annotations", () => {
		const scores = [makeScore()];
		const annotations = makeAnnotations(5);
		const result = generateFeedback(scores, annotations);
		expect(result).toBe("");
	});

	test("returns empty string for exactly 9 annotations", () => {
		const scores = [makeScore()];
		const annotations = makeAnnotations(9);
		const result = generateFeedback(scores, annotations);
		expect(result).toBe("");
	});

	test("injects warning for low pass rate domain", () => {
		const scores = [
			makeScore({
				dimension: "domain",
				value: "frontend",
				passRate: 0.3,
				totalAnnotations: 10,
				passCount: 3,
				failCount: 7,
			}),
		];
		const annotations = makeAnnotations(15, { domain: "frontend", verdict: "fail" });

		const result = generateFeedback(scores, annotations, "frontend");
		expect(result).not.toBe("");
		expect(result.toLowerCase()).toContain("frontend");
	});

	test("injects encouragement for high pass rate domain", () => {
		const scores = [
			makeScore({
				dimension: "domain",
				value: "backend",
				passRate: 0.9,
				totalAnnotations: 10,
				passCount: 9,
				failCount: 1,
			}),
		];
		const annotations = makeAnnotations(15, { domain: "backend", verdict: "pass" });

		const result = generateFeedback(scores, annotations, "backend");
		expect(result).not.toBe("");
		// Should include some positive note about the domain
		expect(result.toLowerCase()).toContain("backend");
	});

	test("includes failure feedback patterns from annotations", () => {
		const scores = [
			makeScore({
				dimension: "domain",
				value: "frontend",
				passRate: 0.3,
				totalAnnotations: 10,
				passCount: 3,
				failCount: 7,
			}),
		];
		const annotations = [
			...makeAnnotations(10, {
				domain: "frontend",
				verdict: "fail",
				feedback: "Failed to handle edge case",
			}),
			...makeAnnotations(5, { domain: "frontend", verdict: "pass" }),
		];

		const result = generateFeedback(scores, annotations, "frontend");
		expect(result).not.toBe("");
		// Should reference the failure feedback
		expect(result).toContain("Failed to handle edge case");
	});

	test("injects complexity warning for complex tasks with low pass rate", () => {
		const scores = [
			makeScore({
				dimension: "complexity",
				value: "complex",
				passRate: 0.3,
				totalAnnotations: 8,
				passCount: 2,
				failCount: 6,
			}),
		];
		const annotations = makeAnnotations(15);

		const result = generateFeedback(scores, annotations);
		expect(result).not.toBe("");
		expect(result.toLowerCase()).toMatch(/complex|break.*down/);
	});

	test("returns empty string when no actionable guidance found", () => {
		const scores = [
			makeScore({
				dimension: "overall",
				value: "all",
				passRate: 0.75,
				totalAnnotations: 20,
			}),
		];
		const annotations = makeAnnotations(15);

		// No domain specified, and no low-scoring complexity
		const result = generateFeedback(scores, annotations);
		expect(result).toBe("");
	});

	test("includes header with annotation count when guidance is generated", () => {
		const scores = [
			makeScore({
				dimension: "domain",
				value: "frontend",
				passRate: 0.3,
				totalAnnotations: 10,
				passCount: 3,
				failCount: 7,
			}),
		];
		const annotations = makeAnnotations(15, { domain: "frontend", verdict: "fail" });

		const result = generateFeedback(scores, annotations, "frontend");
		expect(result).toContain("## Empirical Guidance");
		expect(result).toMatch(/\d+ past task annotations/);
	});

	test("does not warn for domain with passRate above threshold", () => {
		const scores = [
			makeScore({
				dimension: "domain",
				value: "backend",
				passRate: 0.6,
				totalAnnotations: 10,
			}),
		];
		const annotations = makeAnnotations(15, { domain: "backend" });

		const result = generateFeedback(scores, annotations, "backend");
		// 0.6 is above the 0.5 failure threshold but below 0.85 encouragement threshold
		// so no domain-specific guidance should appear
		expect(result).toBe("");
	});

	test("generates feedback without taskDomain parameter", () => {
		const scores = [
			makeScore({
				dimension: "complexity",
				value: "complex",
				passRate: 0.2,
				totalAnnotations: 10,
				passCount: 2,
				failCount: 8,
			}),
		];
		const annotations = makeAnnotations(15);

		const result = generateFeedback(scores, annotations);
		expect(result).not.toBe("");
	});
});
