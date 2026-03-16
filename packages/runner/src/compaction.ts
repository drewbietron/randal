import { createLogger } from "@randal/core";
import type { DelegationResult, JobIteration, JobPlanTask } from "@randal/core";

const logger = createLogger({ context: { component: "compaction" } });

// ---- Types ----

export interface CompactionResult {
	compactedContext: string;
	iterationsCompacted: number;
	originalTokens: number;
	compactedTokens: number;
}

export interface CompactionConfig {
	enabled: boolean;
	threshold: number;
	model: string;
	maxSummaryTokens: number;
}

export interface CompactionInput {
	iterations: JobIteration[];
	plan: JobPlanTask[];
	delegations: DelegationResult[];
	injectedContext?: string[];
	compactionConfig: CompactionConfig;
}

// ---- Threshold check ----

/**
 * Determine whether context compaction should be triggered.
 *
 * @param contextLength  Current estimated token count of the context.
 * @param threshold      Fraction (0-1) of maxContextWindow at which to compact.
 * @param maxContextWindow  Maximum context window size in tokens.
 * @returns true if contextLength >= threshold * maxContextWindow
 */
export function shouldCompact(
	contextLength: number,
	threshold: number,
	maxContextWindow: number,
): boolean {
	if (maxContextWindow <= 0) return false;
	const triggerAt = Math.floor(threshold * maxContextWindow);
	const should = contextLength >= triggerAt;

	if (should) {
		logger.info("Compaction threshold reached", {
			contextLength,
			threshold,
			maxContextWindow,
			triggerAt,
		});
	}

	return should;
}

// ---- Compaction ----

/**
 * Compact the conversation context by summarizing older iterations while
 * preserving critical state.
 *
 * Preservation rules:
 *  1. Current plan state — always included in full.
 *  2. Most recent 2 iterations — kept verbatim.
 *  3. All delegation results — always included.
 *  4. All human-injected context — always included.
 *  5. Older iterations — condensed into a rule-based summary.
 */
export function compactContext(input: CompactionInput): CompactionResult {
	const { iterations, plan, delegations, injectedContext, compactionConfig } = input;

	const originalText = buildFullContext(iterations, plan, delegations, injectedContext);
	const originalTokens = estimateTokens(originalText);

	// Nothing to compact if fewer than 3 iterations (we keep 2 verbatim)
	if (iterations.length <= 2) {
		logger.debug("Skipping compaction, too few iterations", {
			count: iterations.length,
		});
		return {
			compactedContext: originalText,
			iterationsCompacted: 0,
			originalTokens,
			compactedTokens: originalTokens,
		};
	}

	// Split iterations: older ones get summarized, recent 2 kept in full
	const recentCount = 2;
	const sorted = [...iterations].sort((a, b) => a.number - b.number);
	const olderIterations = sorted.slice(0, -recentCount);
	const recentIterations = sorted.slice(-recentCount);

	// Build the summarized older section
	const olderSummary = summarizeIterations(olderIterations);

	// Assemble compacted context
	const sections: string[] = [];

	// 1. Plan state
	sections.push(formatPlanSection(plan));

	// 2. Older iteration summary
	if (olderSummary) {
		sections.push(formatSummarySection(olderSummary, olderIterations.length));
	}

	// 3. Recent iterations in full
	for (const iter of recentIterations) {
		sections.push(formatIterationFull(iter));
	}

	// 4. Delegation results
	if (delegations.length > 0) {
		sections.push(formatDelegationsSection(delegations));
	}

	// 5. Human-injected context
	if (injectedContext && injectedContext.length > 0) {
		sections.push(formatInjectedContextSection(injectedContext));
	}

	const compactedText = sections.join("\n\n");
	const compactedTokens = estimateTokens(compactedText);

	// If the summary blows past the max, truncate the older summary to stay within budget
	const maxTokens = compactionConfig.maxSummaryTokens;
	let finalText = compactedText;
	if (compactedTokens > maxTokens && olderSummary) {
		const budgetForSummary = Math.max(
			200,
			maxTokens - estimateTokens(compactedText.replace(olderSummary, "")),
		);
		const truncatedSummary = truncateToTokens(olderSummary, budgetForSummary);
		finalText = compactedText.replace(olderSummary, truncatedSummary);
	}

	const finalTokens = estimateTokens(finalText);

	logger.info("Context compacted", {
		iterationsCompacted: olderIterations.length,
		originalTokens,
		compactedTokens: finalTokens,
		reductionPercent: Math.round((1 - finalTokens / originalTokens) * 100),
	});

	return {
		compactedContext: finalText,
		iterationsCompacted: olderIterations.length,
		originalTokens,
		compactedTokens: finalTokens,
	};
}

// ---- Rule-based iteration summarization ----

/**
 * Produce a condensed summary of multiple iterations using a rule-based
 * approach. Each iteration is reduced to a single line capturing its
 * outcome, files changed, and any notable events.
 */
function summarizeIterations(iterations: JobIteration[]): string {
	if (iterations.length === 0) return "";

	const lines: string[] = [];
	lines.push("## Compacted History");
	lines.push("");

	let totalFiles = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	for (const iter of iterations) {
		const parts: string[] = [];
		parts.push(`Iteration ${iter.number}:`);

		// Summary or status
		if (iter.summary) {
			parts.push(iter.summary);
		} else if (iter.exitCode === 0) {
			parts.push("Completed successfully.");
		} else {
			parts.push(`Exited with code ${iter.exitCode}.`);
		}

		// Files changed
		if (iter.filesChanged.length > 0) {
			totalFiles += iter.filesChanged.length;
			if (iter.filesChanged.length <= 3) {
				parts.push(`Files: ${iter.filesChanged.join(", ")}`);
			} else {
				parts.push(
					`Files: ${iter.filesChanged.slice(0, 3).join(", ")} (+${iter.filesChanged.length - 3} more)`,
				);
			}
		}

		// Plan updates
		if (iter.planUpdate && iter.planUpdate.length > 0) {
			const completed = iter.planUpdate.filter((t: JobPlanTask) => t.status === "completed").length;
			if (completed > 0) {
				parts.push(`Completed ${completed} plan task(s).`);
			}
		}

		// Delegation requests
		if (iter.delegationRequests && iter.delegationRequests.length > 0) {
			parts.push(`Delegated ${iter.delegationRequests.length} task(s).`);
		}

		// Progress notes
		if (iter.progress) {
			parts.push(`Progress: ${iter.progress}`);
		}

		totalInputTokens += iter.tokens.input;
		totalOutputTokens += iter.tokens.output;

		lines.push(`- ${parts.join(" ")}`);
	}

	lines.push("");
	lines.push(
		`*Summary: ${iterations.length} iterations, ${totalFiles} files changed, ` +
			`${totalInputTokens + totalOutputTokens} tokens used.*`,
	);

	return lines.join("\n");
}

// ---- Formatting helpers ----

function formatPlanSection(plan: JobPlanTask[]): string {
	if (plan.length === 0) return "## Current Plan\n\nNo plan established.";

	const lines = ["## Current Plan", ""];
	for (const task of plan) {
		const icon = statusIcon(task.status);
		lines.push(`${icon} ${task.task}`);
	}
	return lines.join("\n");
}

function statusIcon(status: JobPlanTask["status"]): string {
	switch (status) {
		case "completed":
			return "[x]";
		case "in_progress":
			return "[~]";
		case "failed":
			return "[!]";
		case "pending":
			return "[ ]";
	}
	// Unreachable with current JobPlanTask["status"] union, but satisfies tsc
	return "[ ]";
}

function formatSummarySection(summary: string, count: number): string {
	return `<!-- ${count} older iterations compacted -->\n${summary}`;
}

function formatIterationFull(iter: JobIteration): string {
	const lines: string[] = [];
	lines.push(`## Iteration ${iter.number}`);
	lines.push("");

	if (iter.summary) {
		lines.push(iter.summary);
		lines.push("");
	}

	if (iter.filesChanged.length > 0) {
		lines.push(`**Files changed:** ${iter.filesChanged.join(", ")}`);
	}

	lines.push(`**Tokens:** ${iter.tokens.input} in / ${iter.tokens.output} out`);
	lines.push(`**Duration:** ${iter.duration}ms`);
	lines.push(`**Exit code:** ${iter.exitCode}`);

	if (iter.progress) {
		lines.push(`**Progress:** ${iter.progress}`);
	}

	if (iter.planUpdate && iter.planUpdate.length > 0) {
		lines.push("**Plan updates:**");
		for (const task of iter.planUpdate) {
			lines.push(`  ${statusIcon(task.status)} ${task.task}`);
		}
	}

	if (iter.delegationRequests && iter.delegationRequests.length > 0) {
		lines.push("**Delegations requested:**");
		for (const req of iter.delegationRequests) {
			lines.push(`  - ${req.task}${req.agent ? ` (agent: ${req.agent})` : ""}`);
		}
	}

	if (iter.stderr) {
		const stderrPreview =
			iter.stderr.length > 500 ? `${iter.stderr.slice(0, 500)}... (truncated)` : iter.stderr;
		lines.push(`**Stderr:** ${stderrPreview}`);
	}

	return lines.join("\n");
}

function formatDelegationsSection(delegations: DelegationResult[]): string {
	const lines = ["## Delegation Results", ""];
	for (const d of delegations) {
		lines.push(`### ${d.task}`);
		lines.push(`- **Job:** ${d.jobId}`);
		lines.push(`- **Status:** ${d.status}`);
		lines.push(`- **Summary:** ${d.summary}`);
		if (d.filesChanged.length > 0) {
			lines.push(`- **Files:** ${d.filesChanged.join(", ")}`);
		}
		lines.push(`- **Duration:** ${d.duration}ms`);
		if (d.error) {
			lines.push(`- **Error:** ${d.error}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function formatInjectedContextSection(contexts: string[]): string {
	const lines = ["## Injected Context", ""];
	for (const ctx of contexts) {
		lines.push(ctx);
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Build the full (uncompacted) context string from all parts.
 * Used to measure original token count before compaction.
 */
function buildFullContext(
	iterations: JobIteration[],
	plan: JobPlanTask[],
	delegations: DelegationResult[],
	injectedContext?: string[],
): string {
	const sections: string[] = [];
	sections.push(formatPlanSection(plan));

	const sorted = [...iterations].sort((a, b) => a.number - b.number);
	for (const iter of sorted) {
		sections.push(formatIterationFull(iter));
	}

	if (delegations.length > 0) {
		sections.push(formatDelegationsSection(delegations));
	}

	if (injectedContext && injectedContext.length > 0) {
		sections.push(formatInjectedContextSection(injectedContext));
	}

	return sections.join("\n\n");
}

// ---- Token estimation ----

/**
 * Rough token estimate: ~4 characters per token for English text.
 * This is intentionally approximate. For accurate counts the caller
 * should use a real tokenizer.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Truncate text to approximately the given token budget.
 */
function truncateToTokens(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... (truncated)`;
}
