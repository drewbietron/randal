/**
 * Workload routing algorithm for the multi-instance mesh.
 * R4.5: Routes jobs to the best-fit instance based on weighted scoring.
 */

import type { MeshInstance, ReliabilityScore } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "mesh:router" } });

export interface RoutingWeights {
	specialization: number;
	reliability: number;
	load: number;
	modelMatch: number;
}

export interface RoutingContext {
	/** The task prompt to evaluate */
	prompt: string;
	/** Task domain (frontend, backend, etc.) */
	domain?: string;
	/** Requested model */
	model?: string;
	/** Reliability scores for routing decisions */
	reliabilityScores?: ReliabilityScore[];
}

export interface RoutingDecision {
	instance: MeshInstance;
	score: number;
	breakdown: {
		specializationScore: number;
		reliabilityScore: number;
		loadScore: number;
		modelMatchScore: number;
	};
	reason: string;
}

const DEFAULT_WEIGHTS: RoutingWeights = {
	specialization: 0.4,
	reliability: 0.3,
	load: 0.2,
	modelMatch: 0.1,
};

/**
 * Route a task to the best available instance.
 * Returns null if no suitable instance is found (execute locally).
 */
export function routeTask(
	instances: MeshInstance[],
	context: RoutingContext,
	weights: RoutingWeights = DEFAULT_WEIGHTS,
): RoutingDecision | null {
	const available = instances.filter((i) => i.status !== "unhealthy" && i.status !== "offline");

	if (available.length === 0) {
		logger.debug("No available instances for routing");
		return null;
	}

	const scored: RoutingDecision[] = available.map((instance) => {
		const specializationScore = computeSpecializationScore(instance, context);
		const reliabilityScore = computeReliabilityScore(instance, context);
		const loadScore = computeLoadScore(instance);
		const modelMatchScore = computeModelMatchScore(instance, context);

		const totalScore =
			specializationScore * weights.specialization +
			reliabilityScore * weights.reliability +
			loadScore * weights.load +
			modelMatchScore * weights.modelMatch;

		return {
			instance,
			score: totalScore,
			breakdown: {
				specializationScore,
				reliabilityScore,
				loadScore,
				modelMatchScore,
			},
			reason: buildReason(instance, {
				specializationScore,
				reliabilityScore,
				loadScore,
				modelMatchScore,
			}),
		};
	});

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	const best = scored[0];
	if (best.score < 0.1) {
		logger.debug("Best routing score too low, recommend local execution", {
			bestScore: best.score,
		});
		return null;
	}

	logger.info("Task routed", {
		instanceId: best.instance.instanceId,
		instanceName: best.instance.name,
		score: best.score,
		reason: best.reason,
	});

	return best;
}

/**
 * Dry-run the routing algorithm and return all candidates with scores.
 */
export function dryRunRoute(
	instances: MeshInstance[],
	context: RoutingContext,
	weights: RoutingWeights = DEFAULT_WEIGHTS,
): RoutingDecision[] {
	const available = instances.filter((i) => i.status !== "unhealthy" && i.status !== "offline");

	return available
		.map((instance) => {
			const specializationScore = computeSpecializationScore(instance, context);
			const reliabilityScore = computeReliabilityScore(instance, context);
			const loadScore = computeLoadScore(instance);
			const modelMatchScore = computeModelMatchScore(instance, context);

			const totalScore =
				specializationScore * weights.specialization +
				reliabilityScore * weights.reliability +
				loadScore * weights.load +
				modelMatchScore * weights.modelMatch;

			return {
				instance,
				score: totalScore,
				breakdown: {
					specializationScore,
					reliabilityScore,
					loadScore,
					modelMatchScore,
				},
				reason: buildReason(instance, {
					specializationScore,
					reliabilityScore,
					loadScore,
					modelMatchScore,
				}),
			};
		})
		.sort((a, b) => b.score - a.score);
}

function computeSpecializationScore(instance: MeshInstance, context: RoutingContext): number {
	if (!instance.specialization || !context.domain) return 0.5;

	// Exact match
	if (instance.specialization.toLowerCase() === context.domain.toLowerCase()) {
		return 1.0;
	}

	// Partial match (specialization appears in domain or vice versa)
	if (
		instance.specialization.toLowerCase().includes(context.domain.toLowerCase()) ||
		context.domain.toLowerCase().includes(instance.specialization.toLowerCase())
	) {
		return 0.7;
	}

	return 0.2;
}

function computeReliabilityScore(instance: MeshInstance, context: RoutingContext): number {
	if (!context.reliabilityScores) return 0.5;

	// Find per-agent reliability score for this instance
	const agentScore = context.reliabilityScores.find(
		(s) => s.dimension === "agent" && s.value === instance.name,
	);

	if (agentScore) {
		return agentScore.passRate;
	}

	return 0.5;
}

function computeLoadScore(instance: MeshInstance): number {
	if (instance.status === "idle") return 1.0;
	if (instance.activeJobs === 0) return 1.0;
	if (instance.activeJobs === 1) return 0.7;
	if (instance.activeJobs === 2) return 0.4;
	return 0.1;
}

function computeModelMatchScore(instance: MeshInstance, context: RoutingContext): number {
	if (!context.model) return 0.5;
	if (instance.models.includes(context.model)) return 1.0;

	// Partial match (same provider)
	const requestedProvider = context.model.split("/")[0];
	if (instance.models.some((m) => m.startsWith(requestedProvider))) return 0.6;

	return 0.2;
}

function buildReason(
	instance: MeshInstance,
	scores: {
		specializationScore: number;
		reliabilityScore: number;
		loadScore: number;
		modelMatchScore: number;
	},
): string {
	const parts: string[] = [];

	if (scores.specializationScore >= 0.8) {
		parts.push(`specialization match (${instance.specialization})`);
	}
	if (scores.reliabilityScore >= 0.8) {
		parts.push("high reliability");
	}
	if (scores.loadScore >= 0.8) {
		parts.push("low load");
	}
	if (scores.modelMatchScore >= 0.8) {
		parts.push("model available");
	}

	return parts.length > 0 ? parts.join(", ") : "general availability";
}
