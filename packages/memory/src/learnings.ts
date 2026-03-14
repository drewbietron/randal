import type { MemoryCategory } from "@randal/core";

export interface Learning {
	category: MemoryCategory;
	content: string;
}

const VALID_CATEGORIES: Set<string> = new Set([
	"preference",
	"pattern",
	"fact",
	"lesson",
	"escalation",
	"skill-outcome",
]);

/**
 * Parse learnings from markdown content.
 * Expects format: `- [category] content`
 */
export function parseLearnings(markdown: string): Learning[] {
	const learnings: Learning[] = [];

	for (const line of markdown.split("\n")) {
		const trimmed = line.trim();
		// Match: - [category] content (including hyphenated categories like skill-outcome)
		const match = trimmed.match(/^-\s+\[(\w[\w-]*)\]\s+(.+)$/);
		if (!match) continue;

		const [, category, content] = match;
		if (!VALID_CATEGORIES.has(category)) continue;

		learnings.push({
			category: category as MemoryCategory,
			content: content.trim(),
		});
	}

	return learnings;
}
