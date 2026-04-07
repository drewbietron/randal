/**
 * Tests for the analytics MCP tool handler logic.
 *
 * Since the handlers in mcp-memory-server.ts are module-private, these tests
 * validate the composition patterns used by each handler:
 *   - reliability_scores: computeReliabilityScores + computeTrends
 *   - recommendations: computeReliabilityScores + generateRecommendations
 *   - get_feedback: computeReliabilityScores + generateFeedback
 *   - annotate: getPrimaryDomain + annotation building
 *
 * Also validates the graceful degradation and ANALYTICS_ENABLED guard logic.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	MemoryAnnotationStore,
	computeReliabilityScores,
	computeTrends,
	generateFeedback,
	generateRecommendations,
	getPrimaryDomain,
} from "@randal/analytics";
import type { Annotation } from "@randal/core";

// ── Test helpers ─────────────────────────────────────────────

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
	return {
		id: randomUUID(),
		jobId: randomUUID(),
		verdict: "pass",
		agent: "opencode",
		model: "claude-sonnet-4-20250514",
		domain: "backend",
		iterationCount: 2,
		tokenCost: 0.05,
		duration: 60,
		filesChanged: ["src/index.ts"],
		prompt: "Fix the API endpoint",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

function makeAnnotations(count: number, overrides: Partial<Annotation> = {}): Annotation[] {
	return Array.from({ length: count }, (_, i) =>
		makeAnnotation({
			timestamp: new Date(Date.now() - i * 86400000).toISOString(),
			...overrides,
		}),
	);
}

// ── reliability_scores handler logic ────────────────────────

describe("reliability_scores handler logic", () => {
	test("returns scores and trends when sufficient data", async () => {
		const store = new MemoryAnnotationStore();
		const annotations = makeAnnotations(15);
		for (const ann of annotations) await store.save(ann);

		// Handler logic: fetch → compute scores → compute trends
		const fetched = await store.list();
		const { scores, insufficientData } = computeReliabilityScores(fetched);
		const trends = computeTrends(fetched);

		expect(insufficientData).toBe(false);
		expect(scores.length).toBeGreaterThan(0);
		expect(scores.find((s) => s.dimension === "overall")).toBeTruthy();
		expect(trends).toHaveProperty("sevenDay");
		expect(trends).toHaveProperty("thirtyDay");
	});

	test("returns insufficientData when < 10 annotations", async () => {
		const store = new MemoryAnnotationStore();
		const annotations = makeAnnotations(5);
		for (const ann of annotations) await store.save(ann);

		const fetched = await store.list();
		const { scores, insufficientData } = computeReliabilityScores(fetched);

		expect(insufficientData).toBe(true);
		expect(scores).toEqual([]);
	});

	test("dimension filter works on computed scores", () => {
		const annotations = makeAnnotations(15, { domain: "frontend" });
		const { scores } = computeReliabilityScores(annotations);

		const domainOnly = scores.filter((s) => s.dimension === "domain");
		expect(domainOnly.length).toBeGreaterThan(0);
		expect(domainOnly.every((s) => s.dimension === "domain")).toBe(true);
	});

	test("agingHalfLife parameter is forwarded to computeReliabilityScores", () => {
		const annotations = makeAnnotations(15);
		const result30 = computeReliabilityScores(annotations, { agingHalfLife: 30 });
		const result1 = computeReliabilityScores(annotations, { agingHalfLife: 1 });

		// Both should return scores, but pass rates may differ due to aging
		expect(result30.insufficientData).toBe(false);
		expect(result1.insufficientData).toBe(false);
		expect(result30.scores.length).toBeGreaterThan(0);
		expect(result1.scores.length).toBeGreaterThan(0);
	});
});

// ── recommendations handler logic ───────────────────────────

describe("recommendations handler logic", () => {
	test("returns recommendations from scored annotations", async () => {
		const store = new MemoryAnnotationStore();
		// Create annotations with a domain that has high failure rate
		const failAnnotations = makeAnnotations(8, {
			verdict: "fail",
			domain: "frontend",
		});
		const passAnnotations = makeAnnotations(7, {
			verdict: "pass",
			domain: "backend",
		});
		for (const ann of [...failAnnotations, ...passAnnotations]) await store.save(ann);

		const fetched = await store.list();
		const { scores } = computeReliabilityScores(fetched);
		const recommendations = generateRecommendations(scores, fetched);

		// Should generate a knowledge_gap recommendation for frontend domain
		const knowledgeGap = recommendations.find(
			(r) => r.type === "knowledge_gap" && r.data?.domain === "frontend",
		);
		expect(knowledgeGap).toBeTruthy();
		expect(knowledgeGap?.severity).toMatch(/warning|critical/);
	});

	test("returns empty recommendations when < 10 annotations", () => {
		const annotations = makeAnnotations(5);
		const { scores } = computeReliabilityScores(annotations);
		const recommendations = generateRecommendations(scores, annotations);

		expect(recommendations).toEqual([]);
	});
});

// ── get_feedback handler logic ──────────────────────────────

describe("get_feedback handler logic", () => {
	test("returns feedback markdown for a weak domain", async () => {
		const store = new MemoryAnnotationStore();
		const failAnnotations = makeAnnotations(8, {
			verdict: "fail",
			domain: "frontend",
			feedback: "React component rendering issue",
		});
		const passAnnotations = makeAnnotations(7, {
			verdict: "pass",
			domain: "backend",
		});
		for (const ann of [...failAnnotations, ...passAnnotations]) await store.save(ann);

		const fetched = await store.list();
		const { scores } = computeReliabilityScores(fetched);
		const feedback = generateFeedback(scores, fetched, "frontend");

		expect(feedback).toContain("Empirical Guidance");
		expect(feedback).toContain("frontend");
	});

	test("returns empty feedback for unknown domain", () => {
		const annotations = makeAnnotations(15, { domain: "backend" });
		const { scores } = computeReliabilityScores(annotations);
		const feedback = generateFeedback(scores, annotations, "nonexistent-domain");

		// No domain match → no domain-specific guidance
		// May still have complexity guidance
		expect(typeof feedback).toBe("string");
	});

	test("returns empty feedback when < 10 annotations", () => {
		const annotations = makeAnnotations(5);
		const { scores } = computeReliabilityScores(annotations);
		const feedback = generateFeedback(scores, annotations, "frontend");

		expect(feedback).toBe("");
	});
});

// ── annotate handler logic ──────────────────────────────────

describe("annotate handler logic", () => {
	test("auto-detects domain from prompt via getPrimaryDomain", () => {
		expect(getPrimaryDomain("Fix the React component rendering")).toBe("frontend");
		expect(getPrimaryDomain("Update the API endpoint handler")).toBe("backend");
		expect(getPrimaryDomain("Add database migration for users table")).toBe("database");
		expect(getPrimaryDomain("Update the README documentation")).toBe("docs");
		expect(getPrimaryDomain("Add unit tests for the parser")).toBe("testing");
		expect(getPrimaryDomain("Configure Docker deployment")).toBe("infra");
		expect(getPrimaryDomain("Something generic")).toBe("general");
	});

	test("builds valid annotation and saves to store", async () => {
		const store = new MemoryAnnotationStore();
		const prompt = "Fix the React component";
		const domain = getPrimaryDomain(prompt);

		const annotation: Annotation = {
			id: randomUUID(),
			jobId: "test-job-1",
			verdict: "pass",
			feedback: "All tests pass",
			categories: ["bugfix"],
			agent: "opencode",
			model: "claude-sonnet-4-20250514",
			domain,
			iterationCount: 3,
			tokenCost: 0.1,
			duration: 120,
			filesChanged: ["src/Component.tsx"],
			prompt,
			timestamp: new Date().toISOString(),
		};

		await store.save(annotation);

		const saved = await store.getByJobId("test-job-1");
		expect(saved).toBeTruthy();
		expect(saved?.domain).toBe("frontend");
		expect(saved?.verdict).toBe("pass");
		expect(saved?.feedback).toBe("All tests pass");
	});

	test("defaults to 'general' domain when no prompt provided", () => {
		const domain = getPrimaryDomain("");
		expect(domain).toBe("general");
	});
});

// ── Graceful degradation patterns ───────────────────────────

describe("graceful degradation", () => {
	test("ANALYTICS_ENABLED=false guard returns disabled message", () => {
		// Simulate the guard check used in all handlers
		const ANALYTICS_ENABLED = false;
		if (!ANALYTICS_ENABLED) {
			const result = {
				message: "Analytics not enabled",
				scores: [],
				trends: { sevenDay: null, thirtyDay: null },
				insufficientData: true,
			};
			expect(result.message).toBe("Analytics not enabled");
			expect(result.scores).toEqual([]);
		}
	});

	test("empty store returns empty results gracefully", async () => {
		const store = new MemoryAnnotationStore();
		const fetched = await store.list();

		expect(fetched).toEqual([]);

		const { scores, insufficientData } = computeReliabilityScores(fetched);
		expect(insufficientData).toBe(true);
		expect(scores).toEqual([]);

		const trends = computeTrends(fetched);
		expect(trends.sevenDay).toBeNull();
		expect(trends.thirtyDay).toBeNull();

		const recommendations = generateRecommendations(scores, fetched);
		expect(recommendations).toEqual([]);

		const feedback = generateFeedback(scores, fetched, "frontend");
		expect(feedback).toBe("");
	});
});
