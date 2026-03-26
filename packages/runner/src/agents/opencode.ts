import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SkillCleanup, SkillDeployment, ToolUseEvent } from "@randal/core";
import { stringify as stringifyYaml } from "yaml";
import type { AgentAdapter } from "./adapter.js";

export const opencode: AgentAdapter = {
	binary: "opencode",
	skillDir: ".opencode/skills",

	buildCommand(opts) {
		const args = ["run"];
		if (opts.agentName) args.push("--agent", opts.agentName);
		if (opts.model) args.push("--model", opts.model);
		args.push(opts.prompt);
		return args;
	},

	parseToolUse(line: string): ToolUseEvent | null {
		// OpenCode tool use patterns:
		// "tool:read {file: "path/to/file"}"
		// "tool:edit {file: "path/to/file"}"
		// "tool:bash {command: "ls -la"}"
		// "tool:write {file: "path/to/file"}"
		const toolMatch = line.match(/^tool:(\w+)\s*(.*)$/);
		if (toolMatch) {
			return {
				tool: toolMatch[1],
				args: toolMatch[2]?.trim() || undefined,
			};
		}

		// Alternative format: "[tool] ToolName: args"
		const bracketMatch = line.match(/^\[tool\]\s*(\w+):\s*(.+)$/);
		if (bracketMatch) {
			return {
				tool: bracketMatch[1],
				args: bracketMatch[2].trim(),
			};
		}

		return null;
	},

	async deploySkills(skills: SkillDeployment[], workdir: string): Promise<SkillCleanup> {
		const paths: string[] = [];

		for (const skill of skills) {
			const dir = resolve(workdir, ".opencode/skills", skill.name);
			await mkdir(dir, { recursive: true });

			const filePath = resolve(dir, "SKILL.md");
			const fm: Record<string, unknown> = {
				name: skill.name,
				description: skill.description,
				...skill.frontmatter,
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
