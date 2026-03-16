import { describe, expect, test } from "bun:test";
import { DEFAULT_DOMAIN_KEYWORDS, categorizePrompt, getPrimaryDomain } from "./categorizer.js";

describe("categorizePrompt", () => {
	test("returns ['frontend'] for React component prompt", () => {
		const result = categorizePrompt("build a React component");
		expect(result).toContain("frontend");
		expect(result[0]).toBe("frontend");
	});

	test("returns ['database'] for SQL query prompt", () => {
		const result = categorizePrompt("fix the SQL query");
		expect(result).toContain("database");
		expect(result[0]).toBe("database");
	});

	test("returns ['infra'] for Docker deployment prompt", () => {
		const result = categorizePrompt("write Docker deployment");
		expect(result).toContain("infra");
		expect(result[0]).toBe("infra");
	});

	test("returns multiple domains sorted by keyword count for mixed prompt", () => {
		const result = categorizePrompt(
			"build a React component with CSS that calls a REST API endpoint",
		);
		expect(result.length).toBeGreaterThanOrEqual(2);
		expect(result).toContain("frontend");
		expect(result).toContain("backend");
		// frontend should come first since React + CSS > REST + API
		expect(result.indexOf("frontend")).toBeLessThan(result.indexOf("backend"));
	});

	test("returns empty array for prompt with no matching keywords", () => {
		const result = categorizePrompt("blorp zazzle plonk");
		expect(result).toEqual([]);
	});

	test("is case insensitive", () => {
		const result = categorizePrompt("Build a REACT COMPONENT with CSS");
		expect(result).toContain("frontend");
	});

	test("detects backend keywords", () => {
		const result = categorizePrompt("create a REST API endpoint with middleware");
		expect(result).toContain("backend");
	});

	test("detects testing keywords", () => {
		const result = categorizePrompt("write unit test with jest and mock data");
		expect(result).toContain("testing");
	});

	test("detects docs keywords", () => {
		const result = categorizePrompt("update the readme documentation");
		expect(result).toContain("docs");
	});

	test("returns domains sorted by match count descending", () => {
		// Use prompt with multiple frontend keywords and one backend keyword
		const result = categorizePrompt(
			"create a React component with tailwind CSS layout and responsive UI that calls an API",
		);
		expect(result[0]).toBe("frontend");
	});

	test("uses custom keyword map when provided", () => {
		const customKeywords = {
			mobile: ["flutter", "swift", "kotlin", "react native"],
			ml: ["tensorflow", "pytorch", "model", "training"],
		};
		const result = categorizePrompt("build a flutter mobile app", customKeywords);
		expect(result).toContain("mobile");
		expect(result).not.toContain("frontend");
	});

	test("custom keyword map overrides defaults", () => {
		const customKeywords = {
			custom: ["react", "api"],
		};
		const result = categorizePrompt("build a react api", customKeywords);
		expect(result).toEqual(["custom"]);
	});
});

describe("getPrimaryDomain", () => {
	test("returns 'general' for prompt with no matching keywords", () => {
		const result = getPrimaryDomain("blorp zazzle plonk");
		expect(result).toBe("general");
	});

	test("returns the top domain for a matching prompt", () => {
		const result = getPrimaryDomain("build a React component with CSS");
		expect(result).toBe("frontend");
	});

	test("returns 'backend' for API-related prompt", () => {
		const result = getPrimaryDomain("create REST API endpoint with express middleware");
		expect(result).toBe("backend");
	});

	test("returns 'database' for SQL prompt", () => {
		const result = getPrimaryDomain("write a SQL migration for postgres schema");
		expect(result).toBe("database");
	});

	test("returns 'infra' for deployment prompt", () => {
		const result = getPrimaryDomain("set up docker kubernetes deployment with terraform");
		expect(result).toBe("infra");
	});

	test("uses custom keyword map", () => {
		const customKeywords = {
			mobile: ["flutter", "swift"],
		};
		const result = getPrimaryDomain("build flutter app", customKeywords);
		expect(result).toBe("mobile");
	});

	test("returns 'general' with custom keyword map when no match", () => {
		const customKeywords = {
			mobile: ["flutter"],
		};
		const result = getPrimaryDomain("blorp zazzle plonk", customKeywords);
		expect(result).toBe("general");
	});
});

describe("DEFAULT_DOMAIN_KEYWORDS", () => {
	test("contains all expected domains", () => {
		const domains = Object.keys(DEFAULT_DOMAIN_KEYWORDS);
		expect(domains).toContain("frontend");
		expect(domains).toContain("backend");
		expect(domains).toContain("database");
		expect(domains).toContain("infra");
		expect(domains).toContain("docs");
		expect(domains).toContain("testing");
	});

	test("each domain has at least 5 keywords", () => {
		for (const [domain, keywords] of Object.entries(DEFAULT_DOMAIN_KEYWORDS)) {
			expect(keywords.length).toBeGreaterThanOrEqual(5);
		}
	});

	test("frontend contains react", () => {
		expect(DEFAULT_DOMAIN_KEYWORDS.frontend).toContain("react");
	});

	test("backend contains api", () => {
		expect(DEFAULT_DOMAIN_KEYWORDS.backend).toContain("api");
	});

	test("database contains sql", () => {
		expect(DEFAULT_DOMAIN_KEYWORDS.database).toContain("sql");
	});

	test("infra contains docker", () => {
		expect(DEFAULT_DOMAIN_KEYWORDS.infra).toContain("docker");
	});
});
