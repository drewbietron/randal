import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillContent, parseSkillFile } from "./parser.js";

describe("parseSkillFile", () => {
	test("parses valid SKILL.md with frontmatter", () => {
		const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
		const filePath = join(dir, "SKILL.md");
		writeFileSync(
			filePath,
			`---
name: notion-api
description: Interact with the Notion API
tags: [notion, api]
requires:
  env: [NOTION_API_KEY]
  binaries: []
version: 1
---

# Notion API Integration

## Authentication
Use the NOTION_API_KEY environment variable.
`,
		);

		const skill = parseSkillFile(filePath);

		expect(skill.meta.name).toBe("notion-api");
		expect(skill.meta.description).toBe("Interact with the Notion API");
		expect(skill.meta.tags).toEqual(["notion", "api"]);
		expect(skill.meta.requires?.env).toEqual(["NOTION_API_KEY"]);
		expect(skill.meta.requires?.binaries).toEqual([]);
		expect(skill.meta.version).toBe(1);
		expect(skill.content).toContain("# Notion API Integration");
		expect(skill.content).toContain("Use the NOTION_API_KEY environment variable.");
		expect(skill.filePath).toBe(filePath);

		rmSync(dir, { recursive: true });
	});

	test("preserves unknown frontmatter fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
		const filePath = join(dir, "SKILL.md");
		writeFileSync(
			filePath,
			`---
name: my-skill
description: A test skill
allowed-tools: [bash, write]
model: claude-sonnet-4
context: project
custom-field: hello
---

# My Skill Content
`,
		);

		const skill = parseSkillFile(filePath);

		expect(skill.meta.name).toBe("my-skill");
		expect(skill.meta["allowed-tools"]).toEqual(["bash", "write"]);
		expect(skill.meta.model).toBe("claude-sonnet-4");
		expect(skill.meta.context).toBe("project");
		expect(skill.meta["custom-field"]).toBe("hello");

		rmSync(dir, { recursive: true });
	});

	test("rejects missing required fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
		const filePath = join(dir, "SKILL.md");
		writeFileSync(
			filePath,
			`---
name: test
---

# Content
`,
		);

		expect(() => parseSkillFile(filePath)).toThrow();

		rmSync(dir, { recursive: true });
	});

	test("rejects invalid name format", () => {
		const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
		const filePath = join(dir, "SKILL.md");
		writeFileSync(
			filePath,
			`---
name: Invalid Name With Spaces
description: A test
---

# Content
`,
		);

		expect(() => parseSkillFile(filePath)).toThrow();

		rmSync(dir, { recursive: true });
	});

	test("handles minimal frontmatter", () => {
		const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
		const filePath = join(dir, "SKILL.md");
		writeFileSync(
			filePath,
			`---
name: minimal
description: A minimal skill
---

# Minimal Skill
`,
		);

		const skill = parseSkillFile(filePath);
		expect(skill.meta.name).toBe("minimal");
		expect(skill.meta.description).toBe("A minimal skill");
		expect(skill.meta.tags).toBeUndefined();
		expect(skill.meta.requires).toBeUndefined();
		expect(skill.meta.version).toBeUndefined();

		rmSync(dir, { recursive: true });
	});
});

describe("parseSkillContent", () => {
	test("parses skill from string", () => {
		const raw = `---
name: test-skill
description: Test skill for parsing
tags: [test]
---

# Test Content

Some body text.
`;

		const skill = parseSkillContent(raw, "/fake/path/SKILL.md");

		expect(skill.meta.name).toBe("test-skill");
		expect(skill.meta.description).toBe("Test skill for parsing");
		expect(skill.content).toContain("# Test Content");
		expect(skill.content).toContain("Some body text.");
	});
});
