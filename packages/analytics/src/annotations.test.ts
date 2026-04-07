import { beforeEach, describe, expect, test } from "bun:test";
import type { Annotation } from "@randal/core";
import { MemoryAnnotationStore, annotationInputSchema } from "./annotations.js";

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

describe("MemoryAnnotationStore", () => {
	let store: MemoryAnnotationStore;

	beforeEach(() => {
		store = new MemoryAnnotationStore();
	});

	test("save and getByJobId returns the annotation", async () => {
		const annotation = makeAnnotation({ jobId: "job-abc123" });
		await store.save(annotation);

		const result = await store.getByJobId("job-abc123");
		expect(result).not.toBeNull();
		expect(result?.id).toBe(annotation.id);
		expect(result?.jobId).toBe("job-abc123");
		expect(result?.verdict).toBe("pass");
	});

	test("getByJobId returns null for missing jobId", async () => {
		const result = await store.getByJobId("nonexistent");
		expect(result).toBeNull();
	});

	test("list returns all annotations", async () => {
		const a1 = makeAnnotation();
		const a2 = makeAnnotation();
		const a3 = makeAnnotation();
		await store.save(a1);
		await store.save(a2);
		await store.save(a3);

		const all = await store.list();
		expect(all).toHaveLength(3);
	});

	test("list filters by verdict", async () => {
		await store.save(makeAnnotation({ verdict: "pass" }));
		await store.save(makeAnnotation({ verdict: "fail" }));
		await store.save(makeAnnotation({ verdict: "partial" }));
		await store.save(makeAnnotation({ verdict: "pass" }));

		const passes = await store.list({ verdict: "pass" });
		expect(passes).toHaveLength(2);
		expect(passes.every((a) => a.verdict === "pass")).toBe(true);

		const fails = await store.list({ verdict: "fail" });
		expect(fails).toHaveLength(1);
		expect(fails[0].verdict).toBe("fail");
	});

	test("list filters by agent", async () => {
		await store.save(makeAnnotation({ agent: "opencode" }));
		await store.save(makeAnnotation({ agent: "mock" }));
		await store.save(makeAnnotation({ agent: "opencode" }));

		const results = await store.list({ agent: "mock" });
		expect(results).toHaveLength(1);
		expect(results[0].agent).toBe("mock");
	});

	test("list filters by model", async () => {
		await store.save(makeAnnotation({ model: "anthropic/claude-sonnet-4" }));
		await store.save(makeAnnotation({ model: "openai/gpt-4o" }));

		const results = await store.list({ model: "openai/gpt-4o" });
		expect(results).toHaveLength(1);
		expect(results[0].model).toBe("openai/gpt-4o");
	});

	test("list filters by domain", async () => {
		await store.save(makeAnnotation({ domain: "backend" }));
		await store.save(makeAnnotation({ domain: "frontend" }));
		await store.save(makeAnnotation({ domain: "backend" }));

		const results = await store.list({ domain: "frontend" });
		expect(results).toHaveLength(1);
		expect(results[0].domain).toBe("frontend");
	});

	test("list filters by since", async () => {
		const old = new Date("2024-01-01T00:00:00Z").toISOString();
		const recent = new Date("2025-06-01T00:00:00Z").toISOString();

		await store.save(makeAnnotation({ timestamp: old }));
		await store.save(makeAnnotation({ timestamp: recent }));

		const results = await store.list({ since: "2025-01-01T00:00:00Z" });
		expect(results).toHaveLength(1);
		expect(results[0].timestamp).toBe(recent);
	});

	test("list respects limit", async () => {
		for (let i = 0; i < 10; i++) {
			await store.save(makeAnnotation());
		}

		const results = await store.list({ limit: 3 });
		expect(results).toHaveLength(3);
	});

	test("list returns results sorted by timestamp descending", async () => {
		const t1 = "2025-01-01T00:00:00Z";
		const t2 = "2025-06-01T00:00:00Z";
		const t3 = "2025-03-01T00:00:00Z";

		await store.save(makeAnnotation({ timestamp: t1 }));
		await store.save(makeAnnotation({ timestamp: t2 }));
		await store.save(makeAnnotation({ timestamp: t3 }));

		const results = await store.list();
		expect(results[0].timestamp).toBe(t2);
		expect(results[1].timestamp).toBe(t3);
		expect(results[2].timestamp).toBe(t1);
	});

	test("count returns the number of stored annotations", async () => {
		expect(await store.count()).toBe(0);

		await store.save(makeAnnotation());
		await store.save(makeAnnotation());
		expect(await store.count()).toBe(2);

		await store.save(makeAnnotation());
		expect(await store.count()).toBe(3);
	});
});

describe("annotationInputSchema", () => {
	test("validates pass verdict", () => {
		const result = annotationInputSchema.parse({ verdict: "pass" });
		expect(result.verdict).toBe("pass");
	});

	test("validates fail verdict", () => {
		const result = annotationInputSchema.parse({ verdict: "fail" });
		expect(result.verdict).toBe("fail");
	});

	test("validates partial verdict", () => {
		const result = annotationInputSchema.parse({ verdict: "partial" });
		expect(result.verdict).toBe("partial");
	});

	test("validates with optional feedback and categories", () => {
		const result = annotationInputSchema.parse({
			verdict: "pass",
			feedback: "Good job",
			categories: ["frontend", "testing"],
		});
		expect(result.feedback).toBe("Good job");
		expect(result.categories).toEqual(["frontend", "testing"]);
	});

	test("rejects invalid verdict", () => {
		expect(() => annotationInputSchema.parse({ verdict: "excellent" })).toThrow();
	});

	test("rejects missing verdict", () => {
		expect(() => annotationInputSchema.parse({})).toThrow();
	});

	test("rejects non-string feedback", () => {
		expect(() => annotationInputSchema.parse({ verdict: "pass", feedback: 123 })).toThrow();
	});

	test("rejects non-array categories", () => {
		expect(() =>
			annotationInputSchema.parse({ verdict: "pass", categories: "frontend" }),
		).toThrow();
	});
});
