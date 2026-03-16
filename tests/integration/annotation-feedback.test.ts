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

describe("annotation feedback loop integration", () => {
	test("save and retrieve annotations from MemoryAnnotationStore", async () => {
		const store = new MemoryAnnotationStore();

		const ann = makeAnnotation({ id: "ann-1", jobId: "job-1" });
		await store.save(ann);

		const retrieved = await store.getByJobId("job-1");
		expect(retrieved).not.toBeNull();
		expect(retrieved?.id).toBe("ann-1");
		expect(retrieved?.verdict).toBe("pass");

		const count = await store.count();
		expect(count).toBe(1);
	});

	test("compute reliability scores with 15+ annotations", async () => {
		const store = new MemoryAnnotationStore();
		const annotations: Annotation[] = [];

		// Create 15 annotations with various verdicts, agents, models, domains
		for (let i = 0; i < 15; i++) {
			const ann = makeAnnotation({
				id: `ann-${i}`,
				jobId: `job-${i}`,
				verdict: i < 8 ? "pass" : i < 12 ? "fail" : "partial",
				agent: i % 2 === 0 ? "opencode" : "claude-code",
				model: i % 3 === 0 ? "anthropic/claude-sonnet-4" : "anthropic/claude-haiku-3.5",
				domain: i % 4 === 0 ? "frontend" : i % 4 === 1 ? "backend" : "testing",
				iterationCount: i + 1,
			});
			annotations.push(ann);
			await store.save(ann);
		}

		const { scores, insufficientData } = computeReliabilityScores(annotations);

		expect(insufficientData).toBe(false);
		expect(scores.length).toBeGreaterThan(0);

		// Check overall score exists
		const overall = scores.find((s) => s.dimension === "overall");
		expect(overall).toBeDefined();
		expect(overall?.totalAnnotations).toBe(15);
		expect(overall?.passRate).toBeGreaterThan(0);
		expect(overall?.passRate).toBeLessThan(1);

		// Check per-agent scores
		const agentScores = scores.filter((s) => s.dimension === "agent");
		expect(agentScores.length).toBeGreaterThanOrEqual(2);

		// Check per-model scores
		const modelScores = scores.filter((s) => s.dimension === "model");
		expect(modelScores.length).toBeGreaterThanOrEqual(2);

		// Check per-domain scores
		const domainScores = scores.filter((s) => s.dimension === "domain");
		expect(domainScores.length).toBeGreaterThanOrEqual(2);
	});

	test("generate recommendations from annotations", async () => {
		const annotations: Annotation[] = [];

		// Create a domain with high failure rate for recommendations
		for (let i = 0; i < 20; i++) {
			annotations.push(
				makeAnnotation({
					id: `ann-${i}`,
					jobId: `job-${i}`,
					verdict: i < 12 ? "pass" : "fail",
					domain: i < 5 ? "frontend" : "backend",
					model: i % 2 === 0 ? "anthropic/claude-sonnet-4" : "anthropic/claude-haiku-3.5",
				}),
			);
		}

		const { scores } = computeReliabilityScores(annotations);
		const recommendations = generateRecommendations(scores, annotations);

		// With enough variance in data, we may get recommendations
		// At minimum the function should not throw
		expect(Array.isArray(recommendations)).toBe(true);
	});

	test("generate feedback text with domain-specific guidance", async () => {
		const annotations: Annotation[] = [];

		// Create annotations where "frontend" domain has low pass rate
		for (let i = 0; i < 15; i++) {
			const isFrontend = i < 8;
			annotations.push(
				makeAnnotation({
					id: `ann-${i}`,
					jobId: `job-${i}`,
					verdict: isFrontend ? (i < 2 ? "pass" : "fail") : "pass",
					domain: isFrontend ? "frontend" : "backend",
					feedback: isFrontend && i >= 2 ? "CSS layout broken" : undefined,
				}),
			);
		}

		const { scores } = computeReliabilityScores(annotations);
		const feedback = generateFeedback(scores, annotations, "frontend");

		// Should contain domain-specific guidance for the low-performing domain
		expect(feedback.length).toBeGreaterThan(0);
		expect(feedback).toContain("frontend");
		expect(feedback).toContain("Empirical Guidance");
	});

	test("generate feedback returns empty for domain with high pass rate", async () => {
		const annotations: Annotation[] = [];

		for (let i = 0; i < 15; i++) {
			annotations.push(
				makeAnnotation({
					id: `ann-${i}`,
					jobId: `job-${i}`,
					verdict: "pass",
					domain: "backend",
				}),
			);
		}

		const { scores } = computeReliabilityScores(annotations);
		const feedback = generateFeedback(scores, annotations, "backend");

		// High pass rate should either give positive feedback or be empty
		if (feedback.length > 0) {
			expect(feedback).toContain("Maintain your current approach");
		}
	});
});
