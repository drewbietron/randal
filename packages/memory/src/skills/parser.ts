import { readFileSync, statSync } from "node:fs";
import type { SkillDoc, SkillMeta } from "@randal/core";
import matter from "gray-matter";
import { z } from "zod";

/**
 * Zod schema for skill frontmatter validation.
 * Unknown fields are preserved via passthrough.
 */
const skillMetaSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase alphanumeric + hyphens"),
		description: z.string().min(1).max(1024),
		tags: z.array(z.string()).optional(),
		requires: z
			.object({
				env: z.array(z.string()).optional(),
				binaries: z.array(z.string()).optional(),
			})
			.optional(),
		version: z.number().int().optional(),
	})
	.passthrough();

/**
 * Parse a SKILL.md file into a SkillDoc.
 * Extracts YAML frontmatter and body content.
 * Unknown frontmatter fields are preserved for adapter passthrough.
 */
export function parseSkillFile(filePath: string): SkillDoc {
	const raw = readFileSync(filePath, "utf-8");
	return parseSkillContent(raw, filePath);
}

/**
 * Parse skill content from a string (for testing without file IO).
 */
export function parseSkillContent(raw: string, filePath: string): SkillDoc {
	const { data, content } = matter(raw);

	const parsed = skillMetaSchema.parse(data);

	const stat = (() => {
		try {
			return statSync(filePath);
		} catch {
			return null;
		}
	})();

	return {
		meta: parsed as SkillMeta,
		content: content.trim(),
		filePath,
		updated: stat?.mtime?.toISOString() ?? new Date().toISOString(),
	};
}
