import { describe, expect, test } from "bun:test";
import type { Annotation } from "@randal/core";
import {
	MIN_ANNOTATIONS_FOR_SCORES,
	calculateAnnotationWeight,
	computeReliabilityScores,
	computeTrends,
} from "./scoring.js";

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

describe("computeReliabilityScores", () => {
	test("MIN_ANNOTATIONS_FOR_SCORES is 10", () => {
		expect(MIN_ANNOTATIONS_FOR_SCORES).toBe(10);
	});

	test("returns insufficientData when fewer than 10 annotations", () => {
		const annotations = makeAnnotations(5);
		const result = computeReliabilityScores(annotations);
		expect(result.insufficientData).toBe(true);
		expect(result.scores).toEqual([]);
	});

	test("returns insufficientData for 9 annotations", () => {
		const annotations = makeAnnotations(9);
		const result = computeReliabilityScores(annotations);
		expect(result.insufficientData).toBe(true);
	});

	test("returns scores for exactly 10 annotations", () => {
		const annotations = makeAnnotations(10);
		const result = computeReliabilityScores(annotations);
		expect(result.insufficientData).toBe(false);
		expect(result.scores.length).toBeGreaterThan(0);
	});

	test("returns scores with 15+ annotations including overall", () => {
		const annotations = makeAnnotations(15);
		const result = computeReliabilityScores(annotations);
		expect(result.insufficientData).toBe(false);
		expect(result.scores.length).toBeGreaterThan(0);

		const overall = result.scores.find((s) => s.dimension === "overall" && s.value === "all");
		expect(overall).toBeDefined();
		expect(overall?.passRate).toBeGreaterThanOrEqual(0);
		expect(overall?.passRate).toBeLessThanOrEqual(1);
		expect(overall?.totalAnnotations).toBe(15);
	});

	test("computes overall pass rate correctly for mixed verdicts", () => {
		const passes = makeAnnotations(8, { verdict: "pass" });
		const fails = makeAnnotations(4, { verdict: "fail" });
		const annotations = [...passes, ...fails];

		const result = computeReliabilityScores(annotations);
		const overall = result.scores.find((s) => s.dimension === "overall" && s.value === "all");
		expect(overall).toBeDefined();
		// Weighted pass rate should be close to 8/12 = 0.667 for recent annotations
		expect(overall?.passRate).toBeGreaterThan(0.5);
		expect(overall?.passRate).toBeLessThan(0.85);
	});

	test("per-agent breakdown separates agents", () => {
		const opencodeAnnotations = makeAnnotations(6, { agent: "opencode", verdict: "pass" });
		const mockAnnotations = makeAnnotations(6, { agent: "mock", verdict: "fail" });
		const annotations = [...opencodeAnnotations, ...mockAnnotations];

		const result = computeReliabilityScores(annotations);
		const agentScores = result.scores.filter((s) => s.dimension === "agent");
		expect(agentScores.length).toBe(2);

		const opencode = agentScores.find((s) => s.value === "opencode");
		const mock = agentScores.find((s) => s.value === "mock");
		expect(opencode).toBeDefined();
		expect(mock).toBeDefined();
		expect(opencode?.passRate).toBeGreaterThan(mock?.passRate ?? 1);
	});

	test("per-model breakdown separates models", () => {
		const sonnetAnnotations = makeAnnotations(6, {
			model: "anthropic/claude-sonnet-4",
			verdict: "pass",
		});
		const gptAnnotations = makeAnnotations(6, {
			model: "openai/gpt-4o",
			verdict: "fail",
		});
		const annotations = [...sonnetAnnotations, ...gptAnnotations];

		const result = computeReliabilityScores(annotations);
		const modelScores = result.scores.filter((s) => s.dimension === "model");
		expect(modelScores.length).toBe(2);

		const sonnet = modelScores.find((s) => s.value === "anthropic/claude-sonnet-4");
		const gpt = modelScores.find((s) => s.value === "openai/gpt-4o");
		expect(sonnet).toBeDefined();
		expect(gpt).toBeDefined();
		expect(sonnet?.passRate).toBeGreaterThan(gpt?.passRate ?? 1);
	});

	test("per-domain breakdown separates domains", () => {
		const backendAnnotations = makeAnnotations(6, { domain: "backend", verdict: "pass" });
		const frontendAnnotations = makeAnnotations(6, { domain: "frontend", verdict: "fail" });
		const annotations = [...backendAnnotations, ...frontendAnnotations];

		const result = computeReliabilityScores(annotations);
		const domainScores = result.scores.filter((s) => s.dimension === "domain");
		expect(domainScores.length).toBe(2);

		const backend = domainScores.find((s) => s.value === "backend");
		const frontend = domainScores.find((s) => s.value === "frontend");
		expect(backend).toBeDefined();
		expect(frontend).toBeDefined();
		expect(backend?.passRate).toBeGreaterThan(frontend?.passRate ?? 1);
	});

	test("per-complexity breakdown with simple, moderate, complex", () => {
		const simple = makeAnnotations(4, { iterationCount: 2, verdict: "pass" });
		const moderate = makeAnnotations(4, { iterationCount: 7, verdict: "pass" });
		const complex = makeAnnotations(4, { iterationCount: 15, verdict: "fail" });
		const annotations = [...simple, ...moderate, ...complex];

		const result = computeReliabilityScores(annotations);
		const complexityScores = result.scores.filter((s) => s.dimension === "complexity");

		const simpleScore = complexityScores.find((s) => s.value === "simple");
		const moderateScore = complexityScores.find((s) => s.value === "moderate");
		const complexScore = complexityScores.find((s) => s.value === "complex");

		expect(simpleScore).toBeDefined();
		expect(moderateScore).toBeDefined();
		expect(complexScore).toBeDefined();
		// simple and moderate are pass, complex is fail
		expect(simpleScore?.passRate).toBeGreaterThan(complexScore?.passRate ?? 1);
		expect(moderateScore?.passRate).toBeGreaterThan(complexScore?.passRate ?? 1);
	});

	test("score counts are correct", () => {
		const passes = makeAnnotations(7, { verdict: "pass" });
		const fails = makeAnnotations(3, { verdict: "fail" });
		const partials = makeAnnotations(2, { verdict: "partial" });
		const annotations = [...passes, ...fails, ...partials];

		const result = computeReliabilityScores(annotations);
		const overall = result.scores.find((s) => s.dimension === "overall" && s.value === "all");
		expect(overall).toBeDefined();
		expect(overall?.passCount).toBe(7);
		expect(overall?.failCount).toBe(3);
		expect(overall?.partialCount).toBe(2);
		expect(overall?.totalAnnotations).toBe(12);
	});

	test("accepts custom agingHalfLife option", () => {
		const annotations = makeAnnotations(10);
		const result = computeReliabilityScores(annotations, { agingHalfLife: 60 });
		expect(result.insufficientData).toBe(false);
		expect(result.scores.length).toBeGreaterThan(0);
	});
});

describe("calculateAnnotationWeight", () => {
	test("returns 1.0 for current timestamp", () => {
		const now = new Date();
		const weight = calculateAnnotationWeight(now.toISOString(), 30, now);
		expect(weight).toBeCloseTo(1.0, 5);
	});

	test("returns approximately 0.5 for annotation exactly one half-life old", () => {
		const now = new Date();
		const halfLifeDays = 30;
		const halfLifeAgo = new Date(now.getTime() - halfLifeDays * 24 * 60 * 60 * 1000);
		const weight = calculateAnnotationWeight(halfLifeAgo.toISOString(), halfLifeDays, now);
		expect(weight).toBeCloseTo(0.5, 2);
	});

	test("returns approximately 0.25 for annotation two half-lives old", () => {
		const now = new Date();
		const halfLifeDays = 30;
		const twoHalfLivesAgo = new Date(now.getTime() - 2 * halfLifeDays * 24 * 60 * 60 * 1000);
		const weight = calculateAnnotationWeight(twoHalfLivesAgo.toISOString(), halfLifeDays, now);
		expect(weight).toBeCloseTo(0.25, 2);
	});

	test("weight decreases as annotation ages", () => {
		const now = new Date();
		const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
		const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

		const recentWeight = calculateAnnotationWeight(recent.toISOString(), 30, now);
		const oldWeight = calculateAnnotationWeight(old.toISOString(), 30, now);

		expect(recentWeight).toBeGreaterThan(oldWeight);
	});

	test("longer half-life gives more weight to older annotations", () => {
		const now = new Date();
		const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

		const shortHalfLife = calculateAnnotationWeight(thirtyDaysAgo.toISOString(), 30, now);
		const longHalfLife = calculateAnnotationWeight(thirtyDaysAgo.toISOString(), 90, now);

		expect(longHalfLife).toBeGreaterThan(shortHalfLife);
	});
});

describe("computeTrends", () => {
	test("returns null for insufficient data (< 3 in window)", () => {
		const annotations = makeAnnotations(2);
		const result = computeTrends(annotations);
		expect(result.sevenDay).toBeNull();
		expect(result.thirtyDay).toBeNull();
	});

	test("returns null for empty annotations", () => {
		const result = computeTrends([]);
		expect(result.sevenDay).toBeNull();
		expect(result.thirtyDay).toBeNull();
	});

	test("returns 7-day average with enough recent data", () => {
		const now = new Date();
		const recentAnnotations = Array.from({ length: 5 }, (_, i) =>
			makeAnnotation({
				verdict: i < 3 ? "pass" : "fail",
				timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);

		const result = computeTrends(recentAnnotations);
		expect(result.sevenDay).not.toBeNull();
		expect(result.sevenDay).toBeCloseTo(3 / 5, 2);
	});

	test("returns 30-day average with enough data", () => {
		const now = new Date();
		const annotations = Array.from({ length: 10 }, (_, i) =>
			makeAnnotation({
				verdict: i < 7 ? "pass" : "fail",
				timestamp: new Date(now.getTime() - i * 2 * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);

		const result = computeTrends(annotations);
		expect(result.thirtyDay).not.toBeNull();
		expect(result.thirtyDay).toBeGreaterThan(0);
	});

	test("returns null for 7-day when data is older than 7 days", () => {
		const now = new Date();
		const oldAnnotations = Array.from({ length: 5 }, (_, i) =>
			makeAnnotation({
				timestamp: new Date(now.getTime() - (10 + i) * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);

		const result = computeTrends(oldAnnotations);
		expect(result.sevenDay).toBeNull();
	});

	test("all pass annotations give trend close to 1.0", () => {
		const now = new Date();
		const annotations = Array.from({ length: 5 }, (_, i) =>
			makeAnnotation({
				verdict: "pass",
				timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);

		const result = computeTrends(annotations);
		expect(result.sevenDay).toBeCloseTo(1.0, 2);
	});

	test("all fail annotations give trend close to 0.0", () => {
		const now = new Date();
		const annotations = Array.from({ length: 5 }, (_, i) =>
			makeAnnotation({
				verdict: "fail",
				timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);

		const result = computeTrends(annotations);
		expect(result.sevenDay).toBeCloseTo(0.0, 2);
	});
});
