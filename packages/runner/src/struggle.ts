import type { JobIteration } from "@randal/core";

export interface StruggleConfig {
	noChangeThreshold: number;
	maxRepeatedErrors: number;
}

export interface StruggleResult {
	isStuck: boolean;
	indicators: string[];
}

export interface FatalErrorResult {
	isFatal: boolean;
	error: string | null;
}

/**
 * Patterns that indicate the agent cannot proceed and retrying is pointless.
 * Each entry has a regex pattern and a human-readable error message.
 */
const FATAL_ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
	{
		pattern: /not logged in|please run \/login|authentication required|login required/i,
		message: "Agent is not logged in",
	},
	{
		pattern: /api key.{0,20}(?:invalid|expired|missing|not found|not set)/i,
		message: "API key is invalid or missing",
	},
	{
		pattern: /(?:rate limit|quota) exceeded/i,
		message: "Rate limit or quota exceeded",
	},
	{
		pattern: /(?:permission|access) denied|forbidden/i,
		message: "Permission denied",
	},
	{
		pattern: /billing.{0,30}(?:issue|problem|required|inactive)|payment required/i,
		message: "Billing issue",
	},
	{
		pattern:
			/model.{0,60}(?:not found|does not exist|may not exist|unavailable|deprecated|not have access)/i,
		message: "Model not available",
	},
];

/**
 * Detect fatal errors in agent output that make retrying pointless.
 * Checks both stdout and stderr for known unrecoverable error patterns.
 */
export function detectFatalError(output: string, stderr?: string): FatalErrorResult {
	const combined = `${output}\n${stderr ?? ""}`;
	for (const { pattern, message } of FATAL_ERROR_PATTERNS) {
		if (pattern.test(combined)) {
			return { isFatal: true, error: message };
		}
	}
	return { isFatal: false, error: null };
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
