import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SkillCleanup, SkillDeployment, TokenUsage, ToolUseEvent } from "@randal/core";
import { stringify as stringifyYaml } from "yaml";
import type { AgentAdapter } from "./adapter.js";

export const claudeCode: AgentAdapter = {
	binary: "claude",
	skillDir: ".claude/skills",

	buildCommand(opts) {
		const args = ["--print", "--dangerously-skip-permissions"];
		if (opts.model) args.push("--model", opts.model);
		if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
		args.push(opts.prompt);
		return args;
	},

	parseUsage(output: string): TokenUsage | null {
		// Parse "Total cost: $X.XX | Input: Xk | Output: Xk" from Claude Code output
		const match = output.match(/Input:\s*([\d.]+)k.*Output:\s*([\d.]+)k/);
		if (match) {
			return {
				input: Number.parseFloat(match[1]) * 1000,
				output: Number.parseFloat(match[2]) * 1000,
			};
		}
		return null;
	},

	parseToolUse(line: string): ToolUseEvent | null {
		// Claude Code tool use patterns:
		// "Tool: Read file: path/to/file.ts"
		// "Tool: Edit file: path/to/file.ts"
		// "Tool: Bash: ls -la"
		// "Tool: Write file: path/to/file.ts"
		// "Tool: Glob: **/*.ts"
		// "Tool: Grep: pattern"
		const toolMatch = line.match(/^Tool:\s*(\w[\w\s]*?):\s*(.+)$/);
		if (toolMatch) {
			return {
				tool: toolMatch[1].trim(),
				args: toolMatch[2].trim(),
			};
		}

		// Alternative format: "Using tool: ToolName"
		const usingMatch = line.match(/^Using tool:\s*(\w+)/);
		if (usingMatch) {
			return {
				tool: usingMatch[1],
			};
		}

		// Tool result patterns: "Result: ..."
		// We don't emit these as separate events

		return null;
	},

	async deploySkills(skills: SkillDeployment[], workdir: string): Promise<SkillCleanup> {
		const paths: string[] = [];

		for (const skill of skills) {
			const dir = resolve(workdir, ".claude/skills", skill.name);
			await mkdir(dir, { recursive: true });

			const filePath = resolve(dir, "SKILL.md");
			const { tags: _t, requires: _r, version: _v, ...rest } = skill.frontmatter;
			const fm: Record<string, unknown> = {
				name: skill.name,
				description: skill.description,
				...rest,
			};

			const content = `---\n${stringifyYaml(fm)}---\n\n${skill.content}`;
			await writeFile(filePath, content);
			paths.push(dir);
		}

		return {
			deployedPaths: paths,
			cleanup: async () => {
				for (const p of paths) {
					await rm(p, { recursive: true, force: true });
				}
			},
		};
	},
};
