import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import type { DelegationResult, JobPlanTask, PromptContext, RandalConfig } from "@randal/core";
import { createLogger, resolvePromptValue } from "@randal/core";

const logger = createLogger({ context: { component: "prompt-assembly" } });

export interface PromptParts {
	persona?: string;
	systemPrompt?: string;
	rules: string[];
	knowledge: string[];
	skills: string[];
	discoveredSkills: string[];
	memory: string[];
	injectedContext?: string;
	currentPlan?: JobPlanTask[];
	progressHistory?: string[];
	delegationResults?: DelegationResult[];
	/** Whether to include the Randal Execution Protocol section. Defaults to true. */
	includeProtocol?: boolean;
}

/**
 * Load knowledge files matching glob patterns.
 */
export async function loadKnowledgeFiles(patterns: string[], basePath: string): Promise<string[]> {
	const results: string[] = [];

	for (const pattern of patterns) {
		const resolvedPattern = resolve(basePath, pattern);
		try {
			for await (const filePath of glob(resolvedPattern)) {
				try {
					const content = readFileSync(filePath as string, "utf-8");
					results.push(`--- ${filePath} ---\n${content}`);
				} catch (err) {
					logger.debug("Failed to read knowledge file", {
						path: filePath,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		} catch {
			// Skip invalid patterns
		}
	}

	return results;
}

/**
 * Load skill documents for available tools.
 * Supports static .md files, .ts/.js code modules via resolvePromptValue().
 */
export async function loadSkillDocs(
	tools: RandalConfig["tools"],
	basePath: string,
	ctx?: PromptContext,
): Promise<string[]> {
	const results: string[] = [];

	for (const tool of tools) {
		if (!tool.skill) continue;

		// Use resolver if context is available (supports .ts/.js modules + templates)
		if (ctx) {
			try {
				const content = await resolvePromptValue(tool.skill, ctx);
				results.push(`--- Skill: ${tool.name} ---\n${content}`);
			} catch {
				// Skip unresolvable skills
				logger.debug("Failed to resolve skill", { tool: tool.name, skill: tool.skill });
			}
			continue;
		}

		// Fallback: direct file read (backward compat for callers without ctx)
		const skillPath = resolve(basePath, tool.skill);
		if (existsSync(skillPath)) {
			try {
				const content = readFileSync(skillPath, "utf-8");
				results.push(`--- Skill: ${tool.name} ---\n${content}`);
			} catch {
				// Skip unreadable files
			}
		}
	}

	return results;
}

/**
 * Format rules as a numbered list.
 */
export function formatRules(rules: string[]): string {
	if (rules.length === 0) return "";
	return rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n");
}

/**
 * Format the current task plan as a markdown checklist.
 */
export function formatPlan(plan: JobPlanTask[]): string {
	return plan
		.map((t) => {
			const icon =
				t.status === "completed"
					? "[x]"
					: t.status === "in_progress"
						? "[>]"
						: t.status === "failed"
							? "[!]"
							: "[ ]";
			const iterPart = t.iterationNumber ? `, iteration ${t.iterationNumber}` : "";
			return `- ${icon} ${t.task} (${t.status}${iterPart})`;
		})
		.join("\n");
}

/**
 * Format progress history with iteration labels.
 */
export function formatProgressHistory(history: string[], startIteration?: number): string {
	return history
		.map((entry, i) => {
			const iterNum = startIteration ? startIteration + i : i + 1;
			return `### Iteration ${iterNum}\n${entry}`;
		})
		.join("\n\n");
}

/**
 * Format delegation results for prompt injection.
 */
export function formatDelegationResults(results: DelegationResult[]): string {
	return results
		.map((r) => {
			const filesPart =
				r.filesChanged.length > 0
					? `Files changed: ${r.filesChanged.join(", ")}`
					: "No files changed";
			return `### Task: ${r.task}\nStatus: ${r.status} | Job: ${r.jobId} | Duration: ${r.duration}s\n${filesPart}\nSummary: ${r.summary || "No summary"}${r.error ? `\nError: ${r.error}` : ""}`;
		})
		.join("\n\n");
}

/**
 * Build the Randal Execution Protocol section.
 */
export function buildProtocolSection(): string {
	return `## Randal Execution Protocol
You are running inside the Randal execution loop. Use these tags to communicate structured state:

### Task Plan
Output your full task plan when you create or update it:
<plan-update>[{"task":"...","status":"pending|in_progress|completed|failed"}]</plan-update>

### Progress Summary
At the end of your work, summarize what you accomplished:
<progress>What you did, what's next, any blockers.</progress>

### Delegation (optional)
To delegate a subtask to a separate agent run:
<delegate>{"task":"...","context":"...","maxIterations":5}</delegate>
The results will be available in your next iteration.

### Completion
When ALL tasks are complete: <promise>DONE</promise>`;
}

/**
 * Assemble the full system prompt from config and runtime context.
 */
export function assemblePrompt(parts: PromptParts): string {
	const sections: string[] = [];

	if (parts.persona) {
		sections.push(parts.persona.trim());
	}

	if (parts.systemPrompt) {
		sections.push(parts.systemPrompt.trim());
	}

	if (parts.rules.length > 0) {
		sections.push(`## Rules\n${formatRules(parts.rules)}`);
	}

	if (parts.knowledge.length > 0) {
		sections.push(`## Knowledge\n${parts.knowledge.join("\n\n")}`);
	}

	if (parts.skills.length > 0) {
		sections.push(`## Available Tools\n${parts.skills.join("\n\n")}`);
	}

	if (parts.discoveredSkills.length > 0) {
		sections.push(`## Active Skills\n${parts.discoveredSkills.join("\n\n")}`);
	}

	if (parts.memory.length > 0) {
		sections.push(`## Relevant Memory\n${parts.memory.join("\n\n")}`);
	}

	if (parts.injectedContext) {
		sections.push(`## Human Context (Injected)\n${parts.injectedContext.trim()}`);
	}

	if (parts.currentPlan && parts.currentPlan.length > 0) {
		sections.push(`## Current Task Plan\n${formatPlan(parts.currentPlan)}`);
	}

	if (parts.progressHistory && parts.progressHistory.length > 0) {
		sections.push(`## Previous Progress\n${formatProgressHistory(parts.progressHistory)}`);
	}

	if (parts.delegationResults && parts.delegationResults.length > 0) {
		sections.push(`## Delegation Results\n${formatDelegationResults(parts.delegationResults)}`);
	}

	// Include the execution protocol unless explicitly disabled
	if (parts.includeProtocol !== false) {
		sections.push(buildProtocolSection());
	}

	return sections.join("\n\n");
}

/**
 * Build the system prompt for a brain session.
 *
 * The brain owns its own identity, rules, knowledge, and skills.
 * This function only injects channel context (if any).
 */
export async function buildSystemPrompt(
	_config: RandalConfig,
	_basePath: string,
	options: {
		injectedContext?: string;
	} = {},
): Promise<string> {
	// Brain session is the only execution path. The brain owns its own
	// identity, rules, knowledge, and skills. Runner only passes channel
	// context (if any). The job prompt itself is prepended by
	// runBrainSession separately.
	const sections: string[] = [];
	if (options.injectedContext) {
		sections.push(`## Channel Context\n${options.injectedContext.trim()}`);
	}
	return sections.join("\n\n");
}
