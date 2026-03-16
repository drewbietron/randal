/**
 * Feedback injection — adds empirical guidance to system prompts.
 * R5.9: Automatically adds guidance based on annotation patterns.
 */

import type { Annotation, ReliabilityScore } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "analytics:feedback" } });

/** Minimum annotations before injecting feedback */
const MIN_ANNOTATIONS_FOR_FEEDBACK = 10;

/** Failure rate threshold before injecting warnings */
const FAILURE_THRESHOLD = 0.5;

/**
 * Generate feedback text to inject into system prompts based on annotation patterns.
 * Returns empty string if insufficient data or no notable patterns.
 */
export function generateFeedback(
	scores: ReliabilityScore[],
	annotations: Annotation[],
	taskDomain?: string,
): string {
	if (annotations.length < MIN_ANNOTATIONS_FOR_FEEDBACK) {
		return "";
	}

	const lines: string[] = [];

	// Add domain-specific guidance if the current task has a matching domain
	if (taskDomain) {
		const domainScore = scores.find((s) => s.dimension === "domain" && s.value === taskDomain);

		if (domainScore && domainScore.totalAnnotations >= 5) {
			const passRatePct = Math.round(domainScore.passRate * 100);

			if (domainScore.passRate < FAILURE_THRESHOLD) {
				lines.push(
					`Note: Your historical success rate on ${taskDomain} tasks is ${passRatePct}%. Take extra care with this type of task. Review your work thoroughly before completing.`,
				);

				// Add specific patterns from failed annotations in this domain
				const failedInDomain = annotations.filter(
					(a) => a.domain === taskDomain && a.verdict === "fail" && a.feedback,
				);
				if (failedInDomain.length >= 3) {
					const feedbackSample = failedInDomain
						.slice(0, 3)
						.map((a) => a.feedback)
						.filter(Boolean);
					if (feedbackSample.length > 0) {
						lines.push(
							`Common failure feedback on ${taskDomain} tasks: ${feedbackSample.join("; ")}`,
						);
					}
				}
			} else if (domainScore.passRate >= 0.85) {
				lines.push(
					`Note: You have a ${passRatePct}% success rate on ${taskDomain} tasks. Maintain your current approach.`,
				);
			}
		}
	}

	// Add complexity-based guidance
	const complexScores = scores.filter((s) => s.dimension === "complexity");
	const complexScore = complexScores.find((s) => s.value === "complex");
	if (complexScore && complexScore.totalAnnotations >= 5 && complexScore.passRate < 0.5) {
		lines.push(
			"Note: Complex tasks (>10 iterations) have a low success rate. Break down complex work into smaller steps and validate incrementally.",
		);
	}

	if (lines.length === 0) {
		return "";
	}

	return `## Empirical Guidance (from ${annotations.length} past task annotations)\n${lines.join("\n")}`;
}
