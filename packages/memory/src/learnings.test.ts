import { describe, expect, test } from "bun:test";
import { parseLearnings } from "./learnings.js";

describe("parseLearnings", () => {
	test("parses basic learning", () => {
		const result = parseLearnings("- [preference] User likes TypeScript");
		expect(result).toEqual([{ category: "preference", content: "User likes TypeScript" }]);
	});

	test("parses multiple learnings", () => {
		const md = `## Learnings
- [preference] Prefers functional components
- [pattern] Barrel exports in every directory
- [lesson] Run migrations before deploying
- [fact] Supabase project ID is xyz
- [escalation] Auth issues escalate to the team lead`;

		const result = parseLearnings(md);
		expect(result).toHaveLength(5);
		expect(result[0].category).toBe("preference");
		expect(result[1].category).toBe("pattern");
		expect(result[2].category).toBe("lesson");
		expect(result[3].category).toBe("fact");
		expect(result[4].category).toBe("escalation");
	});

	test("skips non-learning lines", () => {
		const md = `# Memory
Some paragraph text.

- [fact] This is a fact
- Regular list item
- [invalid] Not a valid category
`;
		const result = parseLearnings(md);
		expect(result).toHaveLength(1);
		expect(result[0].content).toBe("This is a fact");
	});

	test("handles empty input", () => {
		expect(parseLearnings("")).toEqual([]);
	});

	test("handles no learnings", () => {
		expect(parseLearnings("Just some text\nNo learnings here")).toEqual([]);
	});

	test("preserves content with special characters", () => {
		const result = parseLearnings("- [fact] API endpoint is /api/v1/users?limit=10");
		expect(result[0].content).toBe("API endpoint is /api/v1/users?limit=10");
	});

	test("parses skill-outcome category", () => {
		const md = `## Skill Outcomes
- [skill-outcome] notion-api: Page creation fails if parent_id is a page
- [skill-outcome] github-pr-workflow: Always run tests before creating PR`;

		const result = parseLearnings(md);
		expect(result).toHaveLength(2);
		expect(result[0].category).toBe("skill-outcome");
		expect(result[0].content).toBe("notion-api: Page creation fails if parent_id is a page");
		expect(result[1].category).toBe("skill-outcome");
		expect(result[1].content).toBe("github-pr-workflow: Always run tests before creating PR");
	});

	test("mixes regular learnings and skill-outcomes", () => {
		const md = `- [fact] Server runs on port 3000
- [skill-outcome] deploy-workflow: Must wait for build before deploying
- [lesson] Always check logs after deploy`;

		const result = parseLearnings(md);
		expect(result).toHaveLength(3);
		expect(result[0].category).toBe("fact");
		expect(result[1].category).toBe("skill-outcome");
		expect(result[2].category).toBe("lesson");
	});
});
