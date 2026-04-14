/**
 * Tests for the AnalyticsEngineFacade — validates the adapter between
 * the @randal/analytics pure functions and the HTTP analyticsEngine interface.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MemoryAnnotationStore } from "@randal/analytics";
import type { Annotation, RandalConfig } from "@randal/core";
import type { Runner } from "@randal/runner";
import { AnalyticsEngineFacade } from "./analytics-facade.js";

// ── Helpers ─────────────────────────────────────────────────

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

function makeConfig(overrides: Partial<RandalConfig> = {}): RandalConfig {
	return {
		analytics: { enabled: true, agingHalfLife: 30 },
		...overrides,
	} as unknown as RandalConfig;
}

function makeRunner(jobs: Record<string, Partial<Annotation>> = {}): Runner {
	return {
		getJob: (jobId: string) => {
			const job = jobs[jobId];
			if (!job) return undefined;
			return {
				id: jobId,
				agent: job.agent ?? "opencode",
				model: job.model ?? "claude-sonnet-4-20250514",
				prompt: job.prompt ?? "test prompt",
				iterations: { current: job.iterationCount ?? 1, history: [] },
				cost: {
					estimatedCost: job.tokenCost ?? 0,
					wallTime: job.duration ?? 0,
					totalTokens: { input: 0, output: 0 },
				},
			};
		},
	} as unknown as Runner;
}

async function makeFacade(
	annotations: Annotation[],
	config?: Partial<RandalConfig>,
	jobs?: Record<string, Partial<Annotation>>,
): Promise<AnalyticsEngineFacade> {
	const store = new MemoryAnnotationStore();
	for (const ann of annotations) await store.save(ann);

	const facade = new AnalyticsEngineFacade(store, makeRunner(jobs), makeConfig(config));
	await facade.warmup();
	return facade;
}

// ── getScores ───────────────────────────────────────────────

describe("AnalyticsEngineFacade.getScores", () => {
	test("returns null when insufficient data (< 10 annotations)", async () => {
		const facade = await makeFacade(Array.from({ length: 5 }, () => makeAnnotation()));
		expect(facade.getScores()).toBeNull();
	});

	test("returns scores with correct shape when populated", async () => {
		const annotations = Array.from({ length: 15 }, (_, i) =>
			makeAnnotation({
				agent: i % 2 === 0 ? "opencode" : "harness",
				model: i % 3 === 0 ? "claude-sonnet-4-20250514" : "gpt-4o",
				domain: i % 2 === 0 ? "backend" : "frontend",
				timestamp: new Date(Date.now() - i * 86400000).toISOString(),
			}),
		);
		const facade = await makeFacade(annotations);
		const scores = facade.getScores();

		expect(scores).not.toBeNull();
		if (!scores) throw new Error("expected scores");
		expect(typeof scores.overall).toBe("number");
		expect(scores.overall).toBeGreaterThanOrEqual(0);
		expect(scores.overall).toBeLessThanOrEqual(1);
		expect(typeof scores.byAgent).toBe("object");
		expect(typeof scores.byModel).toBe("object");
		expect(typeof scores.byDomain).toBe("object");
		// Verify agents present
		expect("opencode" in scores.byAgent).toBe(true);
		expect("harness" in scores.byAgent).toBe(true);
	});

	test("byDomain maps domain names to pass rates", async () => {
		const annotations = [
			...Array.from({ length: 8 }, () => makeAnnotation({ verdict: "pass", domain: "backend" })),
			...Array.from({ length: 7 }, () => makeAnnotation({ verdict: "fail", domain: "frontend" })),
		];
		const facade = await makeFacade(annotations);
		const scores = facade.getScores();

		expect(scores).not.toBeNull();
		if (!scores) throw new Error("expected scores");
		expect(scores.byDomain.backend).toBeGreaterThan(scores.byDomain.frontend);
	});
});

// ── getRecommendations ──────────────────────────────────────

describe("AnalyticsEngineFacade.getRecommendations", () => {
	test("returns empty array when insufficient data", async () => {
		const facade = await makeFacade(Array.from({ length: 5 }, () => makeAnnotation()));
		expect(facade.getRecommendations()).toEqual([]);
	});

	test("maps recommendations to { severity, message, action }", async () => {
		const annotations = [
			...Array.from({ length: 8 }, () => makeAnnotation({ verdict: "fail", domain: "frontend" })),
			...Array.from({ length: 7 }, () => makeAnnotation({ verdict: "pass", domain: "backend" })),
		];
		const facade = await makeFacade(annotations);
		const recs = facade.getRecommendations();

		expect(recs.length).toBeGreaterThan(0);
		for (const rec of recs) {
			expect(rec).toHaveProperty("severity");
			expect(rec).toHaveProperty("message");
			expect(["info", "warning", "critical"]).toContain(rec.severity);
			expect(typeof rec.message).toBe("string");
		}
	});
});

// ── getTrends ───────────────────────────────────────────────

describe("AnalyticsEngineFacade.getTrends", () => {
	test("returns trends with range", async () => {
		const annotations = Array.from({ length: 15 }, (_, i) =>
			makeAnnotation({
				timestamp: new Date(Date.now() - i * 86400000).toISOString(),
			}),
		);
		const facade = await makeFacade(annotations);
		const trends = facade.getTrends("30d") as {
			sevenDay: number | null;
			thirtyDay: number | null;
			range: string;
		};

		expect(trends.range).toBe("30d");
		expect(trends).toHaveProperty("sevenDay");
		expect(trends).toHaveProperty("thirtyDay");
	});

	test("defaults range to 7d", async () => {
		const facade = await makeFacade([]);
		const trends = facade.getTrends() as { range: string };
		expect(trends.range).toBe("7d");
	});
});

// ── getAnnotations ──────────────────────────────────────────

describe("AnalyticsEngineFacade.getAnnotations", () => {
	test("filters by jobId", async () => {
		const targetJobId = "target-job";
		const annotations = [
			makeAnnotation({ jobId: targetJobId }),
			makeAnnotation({ jobId: "other-job" }),
			makeAnnotation({ jobId: targetJobId }),
		];
		const facade = await makeFacade(annotations);
		const result = facade.getAnnotations({ jobId: targetJobId }) as Annotation[];

		expect(result.length).toBe(2);
		expect(result.every((a) => a.jobId === targetJobId)).toBe(true);
	});

	test("filters by verdict", async () => {
		const annotations = [
			makeAnnotation({ verdict: "pass" }),
			makeAnnotation({ verdict: "fail" }),
			makeAnnotation({ verdict: "pass" }),
		];
		const facade = await makeFacade(annotations);
		const result = facade.getAnnotations({ verdict: "fail" }) as Annotation[];

		expect(result.length).toBe(1);
		expect(result[0].verdict).toBe("fail");
	});

	test("returns all when no filters", async () => {
		const annotations = Array.from({ length: 5 }, () => makeAnnotation());
		const facade = await makeFacade(annotations);
		const result = facade.getAnnotations();

		expect(result.length).toBe(5);
	});
});

// ── addAnnotation ───────────────────────────────────────────

describe("AnalyticsEngineFacade.addAnnotation", () => {
	test("returns true and saves annotation", async () => {
		const store = new MemoryAnnotationStore();
		const runner = makeRunner({
			"job-1": {
				agent: "opencode",
				model: "claude-sonnet-4-20250514",
				prompt: "Fix the React component rendering",
				iterationCount: 3,
				tokenCost: 0.15,
				duration: 120,
			},
		});
		const facade = new AnalyticsEngineFacade(store, runner, makeConfig());
		await facade.warmup();

		const result = facade.addAnnotation("job-1", {
			verdict: "pass",
			feedback: "All tests pass",
		});

		expect(result).toBe(true);

		// Wait for fire-and-forget save
		await new Promise((r) => setTimeout(r, 50));

		const annotations = await store.list();
		expect(annotations.length).toBe(1);
		expect(annotations[0].verdict).toBe("pass");
		expect(annotations[0].feedback).toBe("All tests pass");
		expect(annotations[0].agent).toBe("opencode");
		expect(annotations[0].domain).toBe("product-engineering"); // auto-detected from "React component"
	});

	test("uses 'general' domain when job not found", async () => {
		const store = new MemoryAnnotationStore();
		const facade = new AnalyticsEngineFacade(store, makeRunner(), makeConfig());
		await facade.warmup();

		facade.addAnnotation("nonexistent", { verdict: "fail" });

		await new Promise((r) => setTimeout(r, 50));

		const annotations = await store.list();
		expect(annotations.length).toBe(1);
		expect(annotations[0].agent).toBe("unknown");
		expect(annotations[0].domain).toBe("general");
	});

	test("invalidates cache after adding annotation", async () => {
		const annotations = Array.from({ length: 15 }, () => makeAnnotation());
		const store = new MemoryAnnotationStore();
		for (const ann of annotations) await store.save(ann);

		const facade = new AnalyticsEngineFacade(store, makeRunner(), makeConfig());
		await facade.warmup();

		// Verify initial state
		expect(facade.getAnnotations().length).toBe(15);

		// Add one more — cache should be invalidated
		facade.addAnnotation("new-job", { verdict: "pass" });

		// Cache is null now, getCachedAnnotations will trigger refresh
		// After warmup re-fetch, the new one should be included
		await facade.warmup();
		expect(facade.getAnnotations().length).toBe(16);
	});
});
