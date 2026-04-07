/**
 * Struggle check — brain-facing interface for struggle detection.
 * Accepts simplified inputs (what the brain knows) rather than
 * JobIteration[] (what the Runner tracks).
 *
 * Used by:
 * - The MCP memory server's `struggle_check` tool (brain calls this during self-monitoring)
 * - The Runner can also call this directly for lightweight checks
 */

export interface StruggleCheckInput {
	iterations_without_progress: number;
	recent_errors: number;
	identical_output_count?: number;
	token_burn_ratio?: number;
}

export interface StruggleCheckResult {
	isStuck: boolean;
	severity: "ok" | "warning" | "critical";
	indicators: string[];
	recommendation: string;
}

export function checkStruggle(input: StruggleCheckInput): StruggleCheckResult {
	const indicators: string[] = [];
	let severity: "ok" | "warning" | "critical" = "ok";

	const {
		iterations_without_progress,
		recent_errors,
		identical_output_count = 0,
		token_burn_ratio = 1.0,
	} = input;

	// No progress detection (mirrors detectStruggle from struggle.ts)
	if (iterations_without_progress >= 3) {
		indicators.push(`No meaningful file changes for ${iterations_without_progress} iterations`);
		severity = "warning";
	}
	if (iterations_without_progress >= 5) {
		severity = "critical";
	}

	// Repeated errors
	if (recent_errors >= 3) {
		indicators.push(`${recent_errors} consecutive errors — likely a persistent issue`);
		severity = severity === "critical" ? "critical" : "warning";
	}
	if (recent_errors >= 5) {
		severity = "critical";
	}

	// Identical output (stale loop)
	if (identical_output_count >= 3) {
		indicators.push(`${identical_output_count} identical outputs — likely stuck in a loop`);
		severity = "critical";
	}

	// Token burn without progress
	if (token_burn_ratio > 1.5 && iterations_without_progress >= 2) {
		indicators.push(
			`High token consumption (${token_burn_ratio.toFixed(1)}x average) without progress`,
		);
		severity = severity === "critical" ? "critical" : "warning";
	}

	const isStuck = indicators.length > 0;

	let recommendation = "Continue working.";
	if (severity === "warning") {
		recommendation =
			"Consider changing approach: try a different strategy, simplify the task, or break it into smaller pieces.";
	} else if (severity === "critical") {
		recommendation =
			"STOP and reassess. You are likely stuck. Try: (1) re-read the error messages carefully, (2) simplify to the smallest reproducing case, (3) try an entirely different approach, (4) ask the user for help.";
	}

	return { isStuck, severity, indicators, recommendation };
}
