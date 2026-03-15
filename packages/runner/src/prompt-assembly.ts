import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import type { RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";

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
 */
export function loadSkillDocs(tools: RandalConfig["tools"], basePath: string): string[] {
	const results: string[] = [];

	for (const tool of tools) {
		if (!tool.skill) continue;

		// Check if tool binary exists on system
		// For now, just load the skill file if it exists
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

	return sections.join("\n\n");
}

/**
 * Build the full system prompt from a config and optional runtime context.
 */
export async function buildSystemPrompt(
	config: RandalConfig,
	basePath: string,
	options: {
		memoryContext?: string[];
		injectedContext?: string;
		skillContext?: string[];
	} = {},
): Promise<string> {
	const knowledge = await loadKnowledgeFiles(config.identity.knowledge, basePath);
	const skills = loadSkillDocs(config.tools, basePath);

	return assemblePrompt({
		persona: config.identity.persona,
		systemPrompt: config.identity.systemPrompt,
		rules: config.identity.rules,
		knowledge,
		skills,
		discoveredSkills: options.skillContext ?? [],
		memory: options.memoryContext ?? [],
		injectedContext: options.injectedContext,
	});
}
