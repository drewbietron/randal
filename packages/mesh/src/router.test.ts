import { describe, expect, test } from "bun:test";
import type { MeshInstance } from "@randal/core";
import { dryRunRoute, routeTask } from "./router.js";
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
				specialization: "backend",
				status: "idle",
				models: ["anthropic/claude-sonnet-4"],
			}),
			makeInstance({
				instanceId: "inst-other",
				specialization: "frontend",
				status: "busy",
				activeJobs: 3,
				models: ["openai/gpt-4o"],
			}),
		];

		const context: RoutingContext = {
			prompt: "Build a REST API",
			domain: "backend",
			model: "anthropic/claude-sonnet-4",
		};

		const result = routeTask(instances, context);
		expect(result).not.toBeNull();
		expect(result?.instance.instanceId).toBe("inst-match");
	});

	test("specialization match gives high score", () => {
		const instances = [
			makeInstance({
				instanceId: "inst-specialized",
				specialization: "backend",
				status: "idle",
			}),
			makeInstance({
				instanceId: "inst-general",
				specialization: "frontend",
				status: "idle",
			}),
		];

		const context: RoutingContext = {
			prompt: "Build API",
			domain: "backend",
		};

		const result = routeTask(instances, context);
		expect(result).not.toBeNull();
		expect(result?.instance.instanceId).toBe("inst-specialized");
		expect(result?.breakdown.specializationScore).toBe(1.0);
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
			specialization: 0.0,
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
			specialization: 0.0,
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
				specialization: "backend",
				status: "idle",
				models: ["anthropic/claude-sonnet-4"],
			}),
		];

		const context: RoutingContext = {
			prompt: "Build API",
			domain: "backend",
			model: "anthropic/claude-sonnet-4",
		};

		const result = routeTask(instances, context);
		expect(result).not.toBeNull();
		expect(result?.score).toBeGreaterThan(0);
		expect(result?.breakdown).toBeDefined();
		expect(typeof result?.breakdown.specializationScore).toBe("number");
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
			specialization: 0.0,
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
				specialization: "frontend",
				status: "busy",
				activeJobs: 3,
			}),
			makeInstance({
				instanceId: "inst-high",
				specialization: "backend",
				status: "idle",
				activeJobs: 0,
			}),
		];

		const context: RoutingContext = {
			prompt: "Build API",
			domain: "backend",
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
				instanceId: "inst-specialized",
				specialization: "backend",
				status: "busy",
				activeJobs: 3,
			}),
			makeInstance({
				instanceId: "inst-idle",
				specialization: "frontend",
				status: "idle",
				activeJobs: 0,
			}),
		];

		const context: RoutingContext = {
			prompt: "Build API",
			domain: "backend",
		};

		// Heavily favor specialization
		const specWeights: RoutingWeights = {
			specialization: 1.0,
			reliability: 0.0,
			load: 0.0,
			modelMatch: 0.0,
		};

		const specResults = dryRunRoute(instances, context, specWeights);
		expect(specResults[0].instance.instanceId).toBe("inst-specialized");

		// Heavily favor load
		const loadWeights: RoutingWeights = {
			specialization: 0.0,
			reliability: 0.0,
			load: 1.0,
			modelMatch: 0.0,
		};

		const loadResults = dryRunRoute(instances, context, loadWeights);
		expect(loadResults[0].instance.instanceId).toBe("inst-idle");
	});
});
