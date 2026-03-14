import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SkillCleanup, SkillDeployment } from "@randal/core";
import { stringify as stringifyYaml } from "yaml";
import type { AgentAdapter } from "./adapter.js";

export const opencode: AgentAdapter = {
	binary: "opencode",
	skillDir: ".opencode/skills",

	buildCommand(opts) {
		const args = ["run"];
		if (opts.model) args.push("--model", opts.model);
		args.push(opts.prompt);
		return args;
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
