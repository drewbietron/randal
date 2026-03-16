/**
 * Reliability scoring engine for the self-learning system.
 * R5.5: Computes per-dimension reliability scores with annotation aging.
 */

import type { Annotation, ReliabilityScore } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "analytics:scoring" } });

/** Minimum annotations required before showing scores */
export const MIN_ANNOTATIONS_FOR_SCORES = 10;

export interface ScoringOptions {
	/** Half-life for annotation aging in days (default: 30) */
	agingHalfLife?: number;
}

/**
 * Calculate the weight of an annotation based on its age.
 * Uses exponential decay: weight = 2^(-age/halfLife)
 */
export function calculateAnnotationWeight(
	annotationTimestamp: string,
	halfLifeDays: number,
	now: Date = new Date(),
): number {
	const annotationDate = new Date(annotationTimestamp);
	const ageDays = (now.getTime() - annotationDate.getTime()) / (1000 * 60 * 60 * 24);
	return 2 ** (-ageDays / halfLifeDays);
}

/**
 * Compute weighted pass rate from annotations.
 */
function computeWeightedScores(
	annotations: Annotation[],
	halfLifeDays: number,
): { passRate: number; passCount: number; failCount: number; partialCount: number } {
	let weightedPass = 0;
	let _weightedFail = 0;
	let _weightedPartial = 0;
	let totalWeight = 0;

	for (const ann of annotations) {
		const weight = calculateAnnotationWeight(ann.timestamp, halfLifeDays);
		totalWeight += weight;

		if (ann.verdict === "pass") {
			weightedPass += weight;
		} else if (ann.verdict === "fail") {
			_weightedFail += weight;
		} else {
			_weightedPartial += weight;
		}
	}

	const passRate = totalWeight > 0 ? weightedPass / totalWeight : 0;

	return {
		passRate,
		passCount: annotations.filter((a) => a.verdict === "pass").length,
		failCount: annotations.filter((a) => a.verdict === "fail").length,
		partialCount: annotations.filter((a) => a.verdict === "partial").length,
	};
}

/**
 * Compute reliability scores across all dimensions.
 * Returns null if insufficient data (<10 annotations).
 */
export function computeReliabilityScores(
	annotations: Annotation[],
	options: ScoringOptions = {},
): { scores: ReliabilityScore[]; insufficientData: boolean } {
	const halfLife = options.agingHalfLife ?? 30;

	if (annotations.length < MIN_ANNOTATIONS_FOR_SCORES) {
		logger.debug("Insufficient annotations for scoring", {
			count: annotations.length,
			minimum: MIN_ANNOTATIONS_FOR_SCORES,
		});
		return { scores: [], insufficientData: true };
	}

	const scores: ReliabilityScore[] = [];

	// Overall score
	const overall = computeWeightedScores(annotations, halfLife);
	scores.push({
		dimension: "overall",
		value: "all",
		totalAnnotations: annotations.length,
		passRate: overall.passRate,
		passCount: overall.passCount,
		failCount: overall.failCount,
		partialCount: overall.partialCount,
	});

	// Per-agent scores
	const byAgent = groupBy(annotations, (a) => a.agent);
	for (const [agent, agentAnnotations] of Object.entries(byAgent)) {
		const agentScores = computeWeightedScores(agentAnnotations, halfLife);
		scores.push({
			dimension: "agent",
			value: agent,
			totalAnnotations: agentAnnotations.length,
			passRate: agentScores.passRate,
			passCount: agentScores.passCount,
			failCount: agentScores.failCount,
			partialCount: agentScores.partialCount,
		});
	}

	// Per-model scores
	const byModel = groupBy(annotations, (a) => a.model);
	for (const [model, modelAnnotations] of Object.entries(byModel)) {
		const modelScores = computeWeightedScores(modelAnnotations, halfLife);
		scores.push({
			dimension: "model",
			value: model,
			totalAnnotations: modelAnnotations.length,
			passRate: modelScores.passRate,
			passCount: modelScores.passCount,
			failCount: modelScores.failCount,
			partialCount: modelScores.partialCount,
		});
	}

	// Per-domain scores
	const byDomain = groupBy(
		annotations.filter((a) => a.domain != null),
		(a) => a.domain as string,
	);
	for (const [domain, domainAnnotations] of Object.entries(byDomain)) {
		const domainScores = computeWeightedScores(domainAnnotations, halfLife);
		scores.push({
			dimension: "domain",
			value: domain,
			totalAnnotations: domainAnnotations.length,
			passRate: domainScores.passRate,
			passCount: domainScores.passCount,
			failCount: domainScores.failCount,
			partialCount: domainScores.partialCount,
		});
	}

	// Per-complexity bracket (by iteration count)
	const complexityBrackets = [
		{ label: "simple", min: 1, max: 3 },
		{ label: "moderate", min: 4, max: 10 },
		{ label: "complex", min: 11, max: Number.POSITIVE_INFINITY },
	];

	for (const bracket of complexityBrackets) {
		const bracketAnnotations = annotations.filter(
			(a) => a.iterationCount >= bracket.min && a.iterationCount <= bracket.max,
		);
		if (bracketAnnotations.length > 0) {
			const bracketScores = computeWeightedScores(bracketAnnotations, halfLife);
			scores.push({
				dimension: "complexity",
				value: bracket.label,
				totalAnnotations: bracketAnnotations.length,
				passRate: bracketScores.passRate,
				passCount: bracketScores.passCount,
				failCount: bracketScores.failCount,
				partialCount: bracketScores.partialCount,
			});
		}
	}

	return { scores, insufficientData: false };
}

/**
 * Compute trend data (rolling averages).
 */
export function computeTrends(annotations: Annotation[]): {
	sevenDay: number | null;
	thirtyDay: number | null;
} {
	const now = new Date();
	const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

	const last7 = annotations.filter(
		(a) => new Date(a.timestamp).getTime() >= sevenDaysAgo.getTime(),
	);
	const last30 = annotations.filter(
		(a) => new Date(a.timestamp).getTime() >= thirtyDaysAgo.getTime(),
	);

	const sevenDay =
		last7.length >= 3 ? last7.filter((a) => a.verdict === "pass").length / last7.length : null;
	const thirtyDay =
		last30.length >= 3 ? last30.filter((a) => a.verdict === "pass").length / last30.length : null;

	return { sevenDay, thirtyDay };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
	const groups: Record<string, T[]> = {};
	for (const item of items) {
		const key = keyFn(item);
		if (!groups[key]) groups[key] = [];
		groups[key].push(item);
	}
	return groups;
}
