import { describe, expect, test } from "bun:test";
import type { MeshInstance } from "@randal/core";
import { cosineSimilarity, dryRunRoute, routeTask } from "./router.js";
import type { RoutingContext, RoutingWeights } from "./router.js";

function makeInstance(overrides: Partial<MeshInstance> = {}): MeshInstance {
	return {
		instanceId: `inst-${Math.random().toString(36).slice(2, 8)}`,
		name: "test-agent",
		capabilities: ["run"],
		status: "idle",
		lastHeartbeat: new Date().toISOString(),
		endpoint: "http://localhost:7600",
		models: ["anthropic/claude-sonnet-4"],
		activeJobs: 0,
		completedJobs: 10,
		health: { uptime: 3600, missedPings: 0 },
		...overrides,
	};
}

describe("routeTask", () => {
	const defaultContext: RoutingContext = {
		prompt: "Build a REST API",
		domain: "backend",
	};

	test("returns null for empty instance list", () => {
		const result = routeTask([], defaultContext);
		expect(result).toBeNull();
	});

	test("returns null when all instances are unhealthy", () => {
		const instances = [makeInstance({ status: "unhealthy" }), makeInstance({ status: "offline" })];

		const result = routeTask(instances, defaultContext);
		expect(result).toBeNull();
	});

	test("selects instance with highest score", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-match",
				role: "product-engineering",
				status: "idle",
				models: ["anthropic/claude-sonnet-4"],
			}),
			makeInstance({
				instanceId: "inst-other",
				role: "security-compliance",
				status: "busy",
				activeJobs: 3,
				models: ["openai/gpt-4o"],
			}),
		];

		const context: RoutingContext = {
			prompt: "Build a REST API",
			domain: "product-engineering",
			model: "anthropic/claude-sonnet-4",
		};

		const result = routeTask(instances, context);
		expect(result).not.toBeNull();
		expect(result?.instance.instanceId).toBe("inst-match");
	});

	test("role match gives high score", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-role-match",
				role: "product-engineering",
				status: "idle",
			}),
			makeInstance({
				instanceId: "inst-other",
				role: "security-compliance",
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Build API",
			domain: "product-engineering",
		};

		const result = routeTask(instances, context);
		expect(result).not.toBeNull();
		expect(result?.instance.instanceId).toBe("inst-role-match");
		expect(result?.breakdown.expertiseScore).toBe(1.0);
	});

	test("load score favors idle instances", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-idle",
				status: "idle",
				activeJobs: 0,
			}),
			makeInstance({
				instanceId: "inst-busy",
				status: "busy",
				activeJobs: 3,
			}),
		];

		const context: RoutingContext = {
			prompt: "Do something",
		};

		// Use weights that heavily favor load
		const weights: RoutingWeights = {
			expertise: 0.0,
			reliability: 0.0,
			load: 1.0,
			modelMatch: 0.0,
		};

		const result = routeTask(instances, context, weights);
		expect(result).not.toBeNull();
		expect(result?.instance.instanceId).toBe("inst-idle");
		expect(result?.breakdown.loadScore).toBe(1.0);
	});

	test("model match boosts score", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-model-match",
				models: ["anthropic/claude-sonnet-4"],
				status: "idle",
			}),
			makeInstance({
				instanceId: "inst-no-match",
				models: ["openai/gpt-4o"],
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Build something",
			model: "anthropic/claude-sonnet-4",
		};

		// Use weights that heavily favor model match
		const weights: RoutingWeights = {
			expertise: 0.0,
			reliability: 0.0,
			load: 0.0,
			modelMatch: 1.0,
		};

		const result = routeTask(instances, context, weights);
		expect(result).not.toBeNull();
		expect(result?.instance.instanceId).toBe("inst-model-match");
		expect(result?.breakdown.modelMatchScore).toBe(1.0);
	});

	test("returns routing decision with breakdown and reason", () => {
		const instances = [
			makeInstance({
				role: "product-engineering",
				status: "idle",
				models: ["anthropic/claude-sonnet-4"],
			}),
		];

		const context: RoutingContext = {
			prompt: "Build API",
			domain: "product-engineering",
			model: "anthropic/claude-sonnet-4",
		};

		const result = routeTask(instances, context);
		expect(result).not.toBeNull();
		expect(result?.score).toBeGreaterThan(0);
		expect(result?.breakdown).toBeDefined();
		expect(typeof result?.breakdown.expertiseScore).toBe("number");
		expect(typeof result?.breakdown.reliabilityScore).toBe("number");
		expect(typeof result?.breakdown.loadScore).toBe("number");
		expect(typeof result?.breakdown.modelMatchScore).toBe("number");
		expect(typeof result?.reason).toBe("string");
	});

	test("filters out unhealthy and offline before scoring", () => {
		const instances = [
			makeInstance({ instanceId: "inst-unhealthy", status: "unhealthy" }),
			makeInstance({ instanceId: "inst-offline", status: "offline" }),
			makeInstance({ instanceId: "inst-idle", status: "idle" }),
		];

		const result = routeTask(instances, defaultContext);
		expect(result).not.toBeNull();
		expect(result?.instance.instanceId).toBe("inst-idle");
	});

	test("same-provider model gives partial match score", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-1",
				models: ["anthropic/claude-haiku-3"],
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Build something",
			model: "anthropic/claude-sonnet-4",
		};

		const weights: RoutingWeights = {
			expertise: 0.0,
			reliability: 0.0,
			load: 0.0,
			modelMatch: 1.0,
		};

		const result = routeTask(instances, context, weights);
		expect(result).not.toBeNull();
		// Same provider (anthropic) should give 0.6
		expect(result?.breakdown.modelMatchScore).toBe(0.6);
	});
});

describe("dryRunRoute", () => {
	test("returns all candidates sorted by score", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-low",
				role: "security-compliance",
				status: "busy",
				activeJobs: 3,
			}),
			makeInstance({
				instanceId: "inst-high",
				role: "product-engineering",
				status: "idle",
				activeJobs: 0,
			}),
		];

		const context: RoutingContext = {
			prompt: "Build API",
			domain: "product-engineering",
		};

		const results = dryRunRoute(instances, context);
		expect(results).toHaveLength(2);
		// Should be sorted descending by score
		expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
		expect(results[0].instance.instanceId).toBe("inst-high");
	});

	test("excludes unhealthy and offline instances", () => {
		const instances = [
			makeInstance({ instanceId: "inst-1", status: "idle" }),
			makeInstance({ instanceId: "inst-2", status: "unhealthy" }),
			makeInstance({ instanceId: "inst-3", status: "offline" }),
		];

		const context: RoutingContext = { prompt: "Build something" };
		const results = dryRunRoute(instances, context);
		expect(results).toHaveLength(1);
		expect(results[0].instance.instanceId).toBe("inst-1");
	});

	test("returns empty array for no available instances", () => {
		const instances = [makeInstance({ status: "unhealthy" }), makeInstance({ status: "offline" })];

		const context: RoutingContext = { prompt: "Build something" };
		const results = dryRunRoute(instances, context);
		expect(results).toEqual([]);
	});

	test("custom routing weights change ranking", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-role-match",
				role: "product-engineering",
				status: "busy",
				activeJobs: 3,
			}),
			makeInstance({
				instanceId: "inst-idle",
				role: "security-compliance",
				status: "idle",
				activeJobs: 0,
			}),
		];

		const context: RoutingContext = {
			prompt: "Build API",
			domain: "product-engineering",
		};

		// Heavily favor expertise (role match)
		const expertiseWeights: RoutingWeights = {
			expertise: 1.0,
			reliability: 0.0,
			load: 0.0,
			modelMatch: 0.0,
		};

		const expertiseResults = dryRunRoute(instances, context, expertiseWeights);
		expect(expertiseResults[0].instance.instanceId).toBe("inst-role-match");

		// Heavily favor load
		const loadWeights: RoutingWeights = {
			expertise: 0.0,
			reliability: 0.0,
			load: 1.0,
			modelMatch: 0.0,
		};

		const loadResults = dryRunRoute(instances, context, loadWeights);
		expect(loadResults[0].instance.instanceId).toBe("inst-idle");
	});
});

describe("cosineSimilarity", () => {
	test("identical vectors return 1.0", () => {
		// Normalized vector: [1/sqrt(2), 1/sqrt(2), 0, 0]
		const v = [Math.SQRT1_2, Math.SQRT1_2, 0, 0];
		expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
	});

	test("orthogonal vectors return 0.0", () => {
		const a = [1, 0, 0, 0];
		const b = [0, 1, 0, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
	});

	test("returns 0 for empty vectors", () => {
		expect(cosineSimilarity([], [])).toBe(0);
	});

	test("returns 0 for mismatched lengths", () => {
		expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
	});

	test("clamps negative dot product to 0", () => {
		// Opposing normalized vectors would give -1, clamped to 0
		const a = [1, 0, 0];
		const b = [-1, 0, 0];
		expect(cosineSimilarity(a, b)).toBe(0);
	});

	test("clamps dot product exceeding 1.0 to 1.0", () => {
		// Non-normalized vectors with large components
		const a = [2, 0];
		const b = [2, 0];
		// dot product = 4, clamped to 1.0
		expect(cosineSimilarity(a, b)).toBe(1.0);
	});
});

describe("computeExpertiseScore via routeTask", () => {
	const expertiseOnlyWeights: RoutingWeights = {
		expertise: 1.0,
		reliability: 0.0,
		load: 0.0,
		modelMatch: 0.0,
	};

	test("cosine similarity: prefers instance with similar expertise vector", () => {
		// Hand-crafted normalized-ish vectors to simulate embedding similarity
		const instances = [
			makeInstance({
				instanceId: "inst-similar",
				expertiseVector: [0.8, 0.1, 0.05, 0.05],
				status: "idle",
			}),
			makeInstance({
				instanceId: "inst-dissimilar",
				expertiseVector: [0.05, 0.05, 0.1, 0.8],
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Build a React component",
			taskVector: [0.9, 0.05, 0.025, 0.025],
		};

		const result = routeTask(instances, context, expertiseOnlyWeights);
		expect(result).not.toBeNull();
		expect(result?.instance.instanceId).toBe("inst-similar");
		// Similar vectors should produce high cosine similarity
		expect(result?.breakdown.expertiseScore).toBeGreaterThan(0.5);
	});

	test("cosine similarity: identical vectors give score close to 1.0", () => {
		// Use L2-normalized vector so dot product = 1.0
		const vec = [0.5, 0.5, 0.5, 0.5]; // magnitude = 1.0
		const instances = [
			makeInstance({
				instanceId: "inst-1",
				expertiseVector: vec,
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Anything",
			taskVector: vec,
		};

		const result = routeTask(instances, context, expertiseOnlyWeights);
		expect(result).not.toBeNull();
		expect(result?.breakdown.expertiseScore).toBeCloseTo(1.0, 1);
	});

	test("cosine similarity: orthogonal vectors give score close to 0.0", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-1",
				expertiseVector: [1, 0, 0, 0],
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Anything",
			taskVector: [0, 1, 0, 0],
		};

		// With orthogonal vectors, expertise score is ~0.0 which means total score < 0.1
		// so routeTask returns null. Use dryRunRoute to see the breakdown.
		const results = dryRunRoute(instances, context, expertiseOnlyWeights);
		expect(results).toHaveLength(1);
		expect(results[0].breakdown.expertiseScore).toBeCloseTo(0.0, 1);
	});

	test("tier 2 fallback: role match when no vectors", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-role-match",
				role: "product-engineering",
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Build an API",
			domain: "product-engineering",
			// No taskVector — triggers Tier 2 fallback
		};

		const result = routeTask(instances, context, expertiseOnlyWeights);
		expect(result).not.toBeNull();
		expect(result?.breakdown.expertiseScore).toBe(1.0);
	});

	test("tier 2 fallback: role mismatch gives low score", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-wrong-role",
				role: "security-compliance",
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Build an API",
			domain: "product-engineering",
			// No taskVector — triggers Tier 2 fallback
		};

		const result = routeTask(instances, context, expertiseOnlyWeights);
		expect(result).not.toBeNull();
		expect(result?.breakdown.expertiseScore).toBe(0.2);
	});

	test("graceful degradation: no vectors, no role returns neutral score", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-bare",
				// No role, no expertiseVector
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Do something",
			domain: "product-engineering",
			// No taskVector
		};

		const result = routeTask(instances, context, expertiseOnlyWeights);
		expect(result).not.toBeNull();
		expect(result?.breakdown.expertiseScore).toBe(0.5);
	});

	test("mixed instances: some with vectors, some without", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-vector",
				role: "product-engineering",
				expertiseVector: [0.85, 0.1, 0.025, 0.025],
				status: "idle",
			}),
			makeInstance({
				instanceId: "inst-role-only",
				role: "product-engineering",
				// No expertiseVector — falls to Tier 2 (role match)
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Build a React component",
			domain: "product-engineering",
			taskVector: [0.9, 0.05, 0.025, 0.025],
		};

		// Use dryRunRoute to see all scores
		const results = dryRunRoute(instances, context, expertiseOnlyWeights);
		expect(results).toHaveLength(2);

		// Both are scored — none excluded
		const vectorResult = results.find((r) => r.instance.instanceId === "inst-vector");
		const roleResult = results.find((r) => r.instance.instanceId === "inst-role-only");

		expect(vectorResult).toBeDefined();
		expect(roleResult).toBeDefined();

		// inst-vector: Tier 1 cosine similarity — high but not 1.0 (vectors are similar, not identical)
		expect(vectorResult?.breakdown.expertiseScore).toBeGreaterThan(0.5);

		// inst-role-only: Tier 2 role match — exact match gives 1.0
		// (role match can actually score higher than cosine similarity for non-identical vectors)
		expect(roleResult?.breakdown.expertiseScore).toBe(1.0);
	});
});
