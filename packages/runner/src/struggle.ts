import type { JobIteration } from "@randal/core";

export interface StruggleConfig {
	noChangeThreshold: number;
	maxRepeatedErrors: number;
}

export interface StruggleResult {
	isStuck: boolean;
	indicators: string[];
}

/**
 * Detect if the agent is struggling based on iteration history.
 */
export function detectStruggle(history: JobIteration[], config: StruggleConfig): StruggleResult {
	const indicators: string[] = [];

	// Check for no file changes across recent iterations
	if (history.length >= config.noChangeThreshold) {
		const recent = history.slice(-config.noChangeThreshold);
		const allEmpty = recent.every((h) => h.filesChanged.length === 0);
		if (allEmpty) {
			indicators.push(`No file changes for ${config.noChangeThreshold} iterations`);
		}
	}

	// Check for repeated errors (same exit code != 0)
	if (history.length >= config.maxRepeatedErrors) {
		const recent = history.slice(-config.maxRepeatedErrors);
		const allFailed = recent.every((h) => h.exitCode !== 0);
		if (allFailed) {
			indicators.push(`Non-zero exit code for ${config.maxRepeatedErrors} consecutive iterations`);
		}
	}

	// Check for repeated identical summaries (stale output)
	if (history.length >= config.noChangeThreshold) {
		const recent = history.slice(-config.noChangeThreshold);
		const summaries = recent.map((h) => h.summary).filter(Boolean);
		if (
			summaries.length >= config.noChangeThreshold &&
			summaries.every((s) => s === summaries[0])
		) {
			indicators.push(`Identical summary for ${config.noChangeThreshold} iterations`);
		}
	}

	// Token burn detection: significantly more tokens than avg without progress
	if (history.length >= 3) {
		const recent = history.slice(-3);
		const avgTokens =
			history.reduce((sum, h) => sum + h.tokens.input + h.tokens.output, 0) / history.length;
		const recentAvg =
			recent.reduce((sum, h) => sum + h.tokens.input + h.tokens.output, 0) / recent.length;
		const noChanges = recent.every((h) => h.filesChanged.length === 0);

		if (noChanges && recentAvg > avgTokens * 1.5) {
			indicators.push("High token consumption without file changes");
		}
	}

	return {
		isStuck: indicators.length > 0,
		indicators,
	};
}
