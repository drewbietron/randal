import type { PromptContext } from "@randal/core";

/**
 * Layer 3: Code module that builds system instructions with conditional logic.
 * Code modules receive the full PromptContext and can produce dynamic content.
 */
export default function buildInstructions(ctx: PromptContext): string {
	const name = ctx.vars?.name ?? "Agent";
	const dayOfWeek = new Date().getDay(); // 0 = Sunday
	const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

	const baseInstructions = `## System Instructions for ${name}

- Write all learnings and important discoveries to MEMORY.md
- Use structured headings and bullet points in your responses
- When you complete a task, summarize what you did`;

	if (isWeekend) {
		return `${baseInstructions}

## Weekend Mode
- Focus on maintenance tasks and cleanup
- Review and organize existing memory entries
- Lower priority on new feature work`;
	}

	return `${baseInstructions}

## Weekday Mode
- Prioritize active development tasks
- Check for any blocked work items
- Review recent commits and pull requests`;
}
