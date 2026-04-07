import { describe, expect, test } from "bun:test";
import type { Annotation, ReliabilityScore } from "@randal/core";
import { generateRecommendations } from "./recommendations.js";

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

describe("generateRecommendations", () => {
	test("returns empty array for fewer than 10 annotations", () => {
		const scores = [makeScore()];
		const annotations = makeAnnotations(5);
		const result = generateRecommendations(scores, annotations);
		expect(result).toEqual([]);
	});

	test("returns empty for exactly 9 annotations", () => {
		const scores = [makeScore()];
		const annotations = makeAnnotations(9);
		const result = generateRecommendations(scores, annotations);
		expect(result).toEqual([]);
	});

	test("generates knowledge_gap recommendation for high failure domain (critical)", () => {
		const scores = [
			makeScore({
				dimension: "domain",
				value: "frontend",
				passRate: 0.2,
				totalAnnotations: 10,
				passCount: 2,
				failCount: 8,
			}),
		];
		const annotations = makeAnnotations(15, { domain: "frontend", verdict: "fail" });

		const result = generateRecommendations(scores, annotations);
		const knowledgeGap = result.find((r) => r.type === "knowledge_gap");
		expect(knowledgeGap).toBeDefined();
		expect(knowledgeGap?.severity).toBe("critical");
		expect(knowledgeGap?.data?.domain).toBe("frontend");
	});

	test("knowledge_gap is warning when pass rate between 0.3 and 0.5", () => {
		const scores = [
			makeScore({
				dimension: "domain",
				value: "database",
				passRate: 0.4,
				totalAnnotations: 8,
				passCount: 3,
				failCount: 5,
			}),
		];
		const annotations = makeAnnotations(15);

		const result = generateRecommendations(scores, annotations);
		const knowledgeGap = result.find((r) => r.type === "knowledge_gap");
		expect(knowledgeGap).toBeDefined();
		expect(knowledgeGap?.severity).toBe("warning");
	});

	test("generates model_switch recommendation when models diverge significantly", () => {
		const scores = [
			makeScore({
				dimension: "model",
				value: "anthropic/claude-sonnet-4",
				passRate: 0.9,
				totalAnnotations: 10,
				passCount: 9,
				failCount: 1,
			}),
			makeScore({
				dimension: "model",
				value: "openai/gpt-4o",
				passRate: 0.4,
				totalAnnotations: 10,
				passCount: 4,
				failCount: 6,
			}),
		];
		const annotations = makeAnnotations(20);

		const result = generateRecommendations(scores, annotations);
		const modelSwitch = result.find((r) => r.type === "model_switch");
		expect(modelSwitch).toBeDefined();
		expect(modelSwitch?.severity).toBe("warning");
		expect(modelSwitch?.data?.betterModel).toBe("anthropic/claude-sonnet-4");
		expect(modelSwitch?.data?.worseModel).toBe("openai/gpt-4o");
	});

	test("does not generate model_switch when models are close in performance", () => {
		const scores = [
			makeScore({
				dimension: "model",
				value: "anthropic/claude-sonnet-4",
				passRate: 0.8,
				totalAnnotations: 10,
			}),
			makeScore({
				dimension: "model",
				value: "openai/gpt-4o",
				passRate: 0.75,
				totalAnnotations: 10,
			}),
		];
		const annotations = makeAnnotations(20);

		const result = generateRecommendations(scores, annotations);
		const modelSwitch = result.find(
			(r) =>
				r.type === "model_switch" &&
				r.data?.betterModel === "anthropic/claude-sonnet-4" &&
				r.data?.worseModel === "openai/gpt-4o",
		);
		expect(modelSwitch).toBeUndefined();
	});

	test("generates split_instance for 50+ tasks across 3+ domains with variance", () => {
		const backendAnns = makeAnnotations(20, { domain: "backend", verdict: "pass" });
		const frontendAnns = makeAnnotations(20, { domain: "frontend", verdict: "fail" });
		const infraAnns = makeAnnotations(15, { domain: "infra", verdict: "pass" });
		const annotations = [...backendAnns, ...frontendAnns, ...infraAnns];

		const scores = [
			makeScore({
				dimension: "domain",
				value: "backend",
				passRate: 0.9,
				totalAnnotations: 20,
			}),
			makeScore({
				dimension: "domain",
				value: "frontend",
				passRate: 0.3,
				totalAnnotations: 20,
			}),
			makeScore({
				dimension: "domain",
				value: "infra",
				passRate: 0.85,
				totalAnnotations: 15,
			}),
		];

		const result = generateRecommendations(scores, annotations);
		const split = result.find((r) => r.type === "split_instance");
		expect(split).toBeDefined();
		expect(split?.severity).toBe("info");
		expect(split?.data?.totalTasks).toBe(55);
		expect(Array.isArray(split?.data?.domains)).toBe(true);
	});

	test("does not generate split_instance for fewer than 50 annotations", () => {
		const annotations = makeAnnotations(30, { domain: "backend" });
		const scores = [
			makeScore({
				dimension: "domain",
				value: "backend",
				passRate: 0.9,
				totalAnnotations: 15,
			}),
			makeScore({
				dimension: "domain",
				value: "frontend",
				passRate: 0.3,
				totalAnnotations: 15,
			}),
		];

		const result = generateRecommendations(scores, annotations);
		const split = result.find((r) => r.type === "split_instance");
		expect(split).toBeUndefined();
	});

	test("generates improvement trend recommendation", () => {
		const now = new Date();
		// First half: mostly fails (old)
		const firstHalf = Array.from({ length: 12 }, (_, i) =>
			makeAnnotation({
				verdict: "fail",
				timestamp: new Date(now.getTime() - (30 - i) * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);
		// Second half: mostly passes (recent)
		const secondHalf = Array.from({ length: 12 }, (_, i) =>
			makeAnnotation({
				verdict: "pass",
				timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);
		const annotations = [...firstHalf, ...secondHalf];
		const scores = [makeScore()];

		const result = generateRecommendations(scores, annotations);
		const general = result.find(
			(r) => r.type === "general" && r.message.toLowerCase().includes("improv"),
		);
		expect(general).toBeDefined();
		expect(general?.severity).toBe("info");
	});

	test("generates decline trend recommendation", () => {
		const now = new Date();
		// First half: mostly passes (old)
		const firstHalf = Array.from({ length: 12 }, (_, i) =>
			makeAnnotation({
				verdict: "pass",
				timestamp: new Date(now.getTime() - (30 - i) * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);
		// Second half: mostly fails (recent)
		const secondHalf = Array.from({ length: 12 }, (_, i) =>
			makeAnnotation({
				verdict: "fail",
				timestamp: new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
			}),
		);
		const annotations = [...firstHalf, ...secondHalf];
		const scores = [makeScore()];

		const result = generateRecommendations(scores, annotations);
		const general = result.find(
			(r) => r.type === "general" && r.message.toLowerCase().includes("declin"),
		);
		expect(general).toBeDefined();
		expect(general?.severity).toBe("warning");
	});

	test("all recommendations have required fields", () => {
		const scores = [
			makeScore({
				dimension: "domain",
				value: "frontend",
				passRate: 0.2,
				totalAnnotations: 10,
				passCount: 2,
				failCount: 8,
			}),
		];
		const annotations = makeAnnotations(15);

		const result = generateRecommendations(scores, annotations);
		for (const rec of result) {
			expect(rec.id).toBeDefined();
			expect(typeof rec.id).toBe("string");
			expect(rec.type).toBeDefined();
			expect(rec.message).toBeDefined();
			expect(typeof rec.message).toBe("string");
			expect(rec.severity).toBeDefined();
			expect(["info", "warning", "critical"]).toContain(rec.severity);
			expect(rec.timestamp).toBeDefined();
		}
	});
});
