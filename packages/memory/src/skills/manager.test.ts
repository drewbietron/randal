import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import { SkillManager } from "./manager.js";

describe("SkillManager", () => {
	const dirs: string[] = [];

	function makeTmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "skill-mgr-test-"));
		dirs.push(dir);
		return dir;
	}

	function makeSkillDir(baseDir: string, name: string, content: string): void {
		const skillDir = join(baseDir, "skills", name);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), content);
	}

	afterEach(() => {
		for (const dir of dirs) {
			try {
				rmSync(dir, { recursive: true });
			} catch {}
		}
		dirs.length = 0;
	});

	test("scans directory and loads skills", async () => {
		const dir = makeTmpDir();

		makeSkillDir(
			dir,
			"notion-api",
			`---
name: notion-api
description: Interact with the Notion API
tags: [notion, api]
---

# Notion API Integration

Use NOTION_API_KEY to authenticate.
`,
		);

		makeSkillDir(
			dir,
			"github-pr",
			`---
name: github-pr
description: Create and manage GitHub pull requests
tags: [github, pr]
---

# GitHub PR Workflow

Always run tests before creating a PR.
`,
		);

		const config = parseConfig(`
name: test
runner:
  workdir: ${dir}
skills:
  dir: ./skills
`);

		const manager = new SkillManager({
			config,
			basePath: dir,
		});

		// Don't call init() to avoid Meilisearch dependency
		await manager.scanDirectory();

		const skills = await manager.list();
		expect(skills).toHaveLength(2);

		const names = skills.map((s) => s.meta.name).sort();
		expect(names).toEqual(["github-pr", "notion-api"]);
	});

	test("getByName returns specific skill", async () => {
		const dir = makeTmpDir();

		makeSkillDir(
			dir,
			"test-skill",
			`---
name: test-skill
description: A test skill
tags: [test]
---

# Test Skill Content
`,
		);

		const config = parseConfig(`
name: test
runner:
  workdir: ${dir}
skills:
  dir: ./skills
`);

		const manager = new SkillManager({
			config,
			basePath: dir,
		});

		await manager.scanDirectory();

		const skill = await manager.getByName("test-skill");
		expect(skill).not.toBeNull();
		expect(skill?.meta.name).toBe("test-skill");
		expect(skill?.content).toContain("# Test Skill Content");

		const missing = await manager.getByName("nonexistent");
		expect(missing).toBeNull();
	});

	test("in-memory search works without Meilisearch", async () => {
		const dir = makeTmpDir();

		makeSkillDir(
			dir,
			"notion-api",
			`---
name: notion-api
description: Interact with the Notion API for page CRUD
tags: [notion, api, integration]
---

# Notion API Integration
`,
		);

		makeSkillDir(
			dir,
			"github-pr",
			`---
name: github-pr
description: Create GitHub pull requests
tags: [github, pr, workflow]
---

# GitHub PR Workflow
`,
		);

		const config = parseConfig(`
name: test
runner:
  workdir: ${dir}
skills:
  dir: ./skills
`);

		const manager = new SkillManager({
			config,
			basePath: dir,
		});

		await manager.scanDirectory();

		// Search by name
		const notionResults = await manager.search("notion");
		expect(notionResults.length).toBeGreaterThanOrEqual(1);
		expect(notionResults[0].meta.name).toBe("notion-api");

		// Search by tag
		const githubResults = await manager.search("github");
		expect(githubResults.length).toBeGreaterThanOrEqual(1);
		expect(githubResults[0].meta.name).toBe("github-pr");
	});

	test("handles empty skills directory", async () => {
		const dir = makeTmpDir();
		mkdirSync(join(dir, "skills"), { recursive: true });

		const config = parseConfig(`
name: test
runner:
  workdir: ${dir}
skills:
  dir: ./skills
`);

		const manager = new SkillManager({
			config,
			basePath: dir,
		});

		await manager.scanDirectory();

		const skills = await manager.list();
		expect(skills).toHaveLength(0);
	});

	test("handles missing skills directory gracefully", async () => {
		const dir = makeTmpDir();

		const config = parseConfig(`
name: test
runner:
  workdir: ${dir}
skills:
  dir: ./nonexistent-skills
`);

		const manager = new SkillManager({
			config,
			basePath: dir,
		});

		// Should not throw
		await manager.scanDirectory();

		const skills = await manager.list();
		expect(skills).toHaveLength(0);
	});

	test("skips directories without SKILL.md", async () => {
		const dir = makeTmpDir();
		mkdirSync(join(dir, "skills", "incomplete"), { recursive: true });
		writeFileSync(join(dir, "skills", "incomplete", "README.md"), "Not a skill");

		makeSkillDir(
			dir,
			"valid-skill",
			`---
name: valid-skill
description: A valid skill
---

# Valid Skill
`,
		);

		const config = parseConfig(`
name: test
runner:
  workdir: ${dir}
skills:
  dir: ./skills
`);

		const manager = new SkillManager({
			config,
			basePath: dir,
		});

		await manager.scanDirectory();

		const skills = await manager.list();
		expect(skills).toHaveLength(1);
		expect(skills[0].meta.name).toBe("valid-skill");
	});
});
