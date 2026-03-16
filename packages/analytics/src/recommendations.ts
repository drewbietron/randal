/**
 * Recommendation engine for the self-learning system.
 * R5.7: Generates actionable suggestions based on annotation patterns.
 */

import { randomBytes } from "node:crypto";
import type { Annotation, Recommendation, ReliabilityScore } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "analytics:recommendations" } });

/** Minimum annotations before generating recommendations */
const MIN_ANNOTATIONS = 10;

/** Failure rate threshold for generating warnings */
const HIGH_FAILURE_THRESHOLD = 0.5;

/** Success rate threshold for identifying strong performers */
const HIGH_SUCCESS_THRESHOLD = 0.85;

/**
 * Generate recommendations from reliability scores and annotation data.
 */
export function generateRecommendations(
	scores: ReliabilityScore[],
	annotations: Annotation[],
): Recommendation[] {
	if (annotations.length < MIN_ANNOTATIONS) {
		return [];
	}

	const recommendations: Recommendation[] = [];
	const now = new Date().toISOString();

	// Check domain-specific failure rates
	const domainScores = scores.filter((s) => s.dimension === "domain");
	for (const ds of domainScores) {
		if (ds.totalAnnotations >= 5 && ds.passRate < HIGH_FAILURE_THRESHOLD) {
			const failPct = Math.round((1 - ds.passRate) * 100);
			recommendations.push({
				id: generateId(),
				type: "knowledge_gap",
				message: `${capitalize(ds.value)} tasks fail ${failPct}% of the time. Consider adding ${ds.value} examples and patterns to knowledge.`,
				severity: ds.passRate < 0.3 ? "critical" : "warning",
				data: { domain: ds.value, passRate: ds.passRate, totalAnnotations: ds.totalAnnotations },
				timestamp: now,
			});
		}
	}

	// Check model divergence across domains
	const modelScores = scores.filter((s) => s.dimension === "model");
	if (modelScores.length >= 2) {
		// Find model with highest overall pass rate
		const best = modelScores.reduce((a, b) => (a.passRate > b.passRate ? a : b));
		for (const ms of modelScores) {
			if (
				ms.value !== best.value &&
				ms.totalAnnotations >= 5 &&
				best.passRate - ms.passRate > 0.3
			) {
				const bestPct = Math.round(best.passRate * 100);
				const msPct = Math.round(ms.passRate * 100);
				recommendations.push({
					id: generateId(),
					type: "model_switch",
					message: `Model ${best.value} succeeds ${bestPct}% vs ${ms.value} at ${msPct}%. Consider switching to ${best.value} for better results.`,
					severity: "warning",
					data: {
						betterModel: best.value,
						worseModel: ms.value,
						betterRate: best.passRate,
						worseRate: ms.passRate,
					},
					timestamp: now,
				});
			}
		}
	}

	// Check for domain-specific model advantages
	checkDomainModelAdvantages(annotations, recommendations, now);

	// Check for split instance recommendation
	const uniqueDomains = new Set(annotations.map((a) => a.domain).filter(Boolean));
	if (annotations.length >= 50 && uniqueDomains.size >= 3) {
		// Check if there's significant domain variance
		const domainPassRates: Record<string, { pass: number; total: number }> = {};
		for (const ann of annotations) {
			if (!ann.domain) continue;
			if (!domainPassRates[ann.domain]) domainPassRates[ann.domain] = { pass: 0, total: 0 };
			domainPassRates[ann.domain].total++;
			if (ann.verdict === "pass") domainPassRates[ann.domain].pass++;
		}

		const rates = Object.entries(domainPassRates)
			.filter(([_, v]) => v.total >= 5)
			.map(([k, v]) => ({ domain: k, rate: v.pass / v.total }));

		if (rates.length >= 2) {
			const maxRate = Math.max(...rates.map((r) => r.rate));
			const minRate = Math.min(...rates.map((r) => r.rate));

			if (maxRate - minRate > 0.3) {
				const topDomains = rates
					.sort((a, b) => b.rate - a.rate)
					.slice(0, 3)
					.map((r) => r.domain);
				recommendations.push({
					id: generateId(),
					type: "split_instance",
					message: `Instance has handled ${annotations.length}+ tasks across ${uniqueDomains.size} domains with varying success. Consider splitting into specialized instances: [${topDomains.join(", ")}].`,
					severity: "info",
					data: { domains: topDomains, totalTasks: annotations.length },
					timestamp: now,
				});
			}
		}
	}

	// Check for improvement after rule changes (based on time trends)
	checkImprovementTrends(annotations, recommendations, now);

	return recommendations;
}

function checkDomainModelAdvantages(
	annotations: Annotation[],
	recommendations: Recommendation[],
	now: string,
): void {
	// Group by domain+model
	const domainModelGroups: Record<string, Record<string, { pass: number; total: number }>> = {};

	for (const ann of annotations) {
		if (!ann.domain) continue;
		if (!domainModelGroups[ann.domain]) domainModelGroups[ann.domain] = {};
		if (!domainModelGroups[ann.domain][ann.model]) {
			domainModelGroups[ann.domain][ann.model] = { pass: 0, total: 0 };
		}
		domainModelGroups[ann.domain][ann.model].total++;
		if (ann.verdict === "pass") domainModelGroups[ann.domain][ann.model].pass++;
	}

	for (const [domain, models] of Object.entries(domainModelGroups)) {
		const entries = Object.entries(models).filter(([_, v]) => v.total >= 3);
		if (entries.length < 2) continue;

		const rates = entries.map(([model, v]) => ({
			model,
			rate: v.pass / v.total,
			total: v.total,
		}));

		const best = rates.reduce((a, b) => (a.rate > b.rate ? a : b));
		const worst = rates.reduce((a, b) => (a.rate < b.rate ? a : b));

		if (best.rate - worst.rate > 0.4 && best.rate >= HIGH_SUCCESS_THRESHOLD) {
			const bestPct = Math.round(best.rate * 100);
			const worstPct = Math.round(worst.rate * 100);
			recommendations.push({
				id: generateId(),
				type: "model_switch",
				message: `Model ${best.model} succeeds ${bestPct}% on ${domain} but ${worst.model} only ${worstPct}%. Consider model ${best.model} for ${domain} tasks.`,
				severity: "warning",
				data: {
					domain,
					betterModel: best.model,
					worseModel: worst.model,
					betterRate: best.rate,
					worseRate: worst.rate,
				},
				timestamp: now,
			});
		}
	}
}

function checkImprovementTrends(
	annotations: Annotation[],
	recommendations: Recommendation[],
	now: string,
): void {
	if (annotations.length < 20) return;

	// Sort by timestamp
	const sorted = [...annotations].sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);

	// Compare first half vs second half
	const mid = Math.floor(sorted.length / 2);
	const firstHalf = sorted.slice(0, mid);
	const secondHalf = sorted.slice(mid);

	const firstPassRate = firstHalf.filter((a) => a.verdict === "pass").length / firstHalf.length;
	const secondPassRate = secondHalf.filter((a) => a.verdict === "pass").length / secondHalf.length;

	const improvement = secondPassRate - firstPassRate;

	if (improvement > 0.1) {
		const improvePct = Math.round(improvement * 100);
		recommendations.push({
			id: generateId(),
			type: "general",
			message: `Success rate improved ${improvePct}% over recent tasks. Current configuration is working well.`,
			severity: "info",
			data: { firstHalfRate: firstPassRate, secondHalfRate: secondPassRate },
			timestamp: now,
		});
	} else if (improvement < -0.1) {
		const declinePct = Math.round(Math.abs(improvement) * 100);
		recommendations.push({
			id: generateId(),
			type: "general",
			message: `Success rate declined ${declinePct}% over recent tasks. Review recent changes to rules and knowledge.`,
			severity: "warning",
			data: { firstHalfRate: firstPassRate, secondHalfRate: secondPassRate },
			timestamp: now,
		});
	}
}

function generateId(): string {
	return randomBytes(8).toString("hex");
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
