import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DOMAIN_KEYWORDS,
	categorizePrompt,
	getPrimaryDomain,
} from "./categorizer.js";

describe("categorizePrompt", () => {
	test("returns ['product-engineering'] for React component prompt", () => {
		const result = categorizePrompt("build a React component");
		expect(result).toContain("product-engineering");
		expect(result[0]).toBe("product-engineering");
	});

	test("returns ['product-engineering'] for SQL query prompt", () => {
		const result = categorizePrompt("fix the SQL query");
		expect(result).toContain("product-engineering");
		expect(result[0]).toBe("product-engineering");
	});

	test("returns ['platform-infrastructure'] for Docker deployment prompt", () => {
		const result = categorizePrompt("write Docker deployment");
		expect(result).toContain("platform-infrastructure");
		expect(result[0]).toBe("platform-infrastructure");
	});

	test("returns multiple domains sorted by keyword count for mixed prompt", () => {
		const result = categorizePrompt(
			"build a React component with CSS that calls a REST API endpoint",
		);
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result).toContain("product-engineering");
	});

	test("returns empty array for prompt with no matching keywords", () => {
		const result = categorizePrompt("blorp zazzle plonk");
		expect(result).toEqual([]);
	});

	test("is case insensitive", () => {
		const result = categorizePrompt("Build a REACT COMPONENT with CSS");
		expect(result).toContain("product-engineering");
	});

	test("detects backend keywords under product-engineering", () => {
		const result = categorizePrompt("create a REST API endpoint with middleware");
		expect(result).toContain("product-engineering");
	});

	test("detects testing keywords under product-engineering", () => {
		const result = categorizePrompt("write unit test with jest and mock data");
		expect(result).toContain("product-engineering");
	});

	test("detects docs keywords under content-communications", () => {
		const result = categorizePrompt("update the readme documentation");
		expect(result).toContain("content-communications");
	});

	test("returns domains sorted by match count descending", () => {
		const result = categorizePrompt(
			"create a React component with tailwind CSS layout and responsive UI that calls an API",
		);
		expect(result[0]).toBe("product-engineering");
	});

	test("uses custom keyword map when provided", () => {
		const customKeywords = {
			mobile: ["flutter", "swift", "kotlin", "react native"],
			ml: ["tensorflow", "pytorch", "model", "training"],
		};
		const result = categorizePrompt("build a flutter mobile app", customKeywords);
		expect(result).toContain("mobile");
		expect(result).not.toContain("product-engineering");
	});

	test("custom keyword map overrides defaults", () => {
		const customKeywords = {
			custom: ["react", "api"],
		};
		const result = categorizePrompt("build a react api", customKeywords);
		expect(result).toEqual(["custom"]);
	});

	test("detects security-compliance domain", () => {
		const result = categorizePrompt(
			"run a security audit on the authentication module for GDPR compliance",
		);
		expect(result).toContain("security-compliance");
	});

	test("detects data-intelligence domain", () => {
		const result = categorizePrompt(
			"build an ETL pipeline to load data into the warehouse for analytics",
		);
		expect(result).toContain("data-intelligence");
	});

	test("detects revenue-growth domain", () => {
		const result = categorizePrompt(
			"create a sales funnel and conversion tracking for the GTM launch",
		);
		expect(result).toContain("revenue-growth");
	});

	test("detects customer-operations domain", () => {
		const result = categorizePrompt(
			"set up zendesk helpdesk for customer support ticket onboarding",
		);
		expect(result).toContain("customer-operations");
	});

	test("detects strategy-finance domain", () => {
		const result = categorizePrompt("build the quarterly OKR roadmap and budget forecast");
		expect(result).toContain("strategy-finance");
	});

	test("detects legal-governance domain", () => {
		const result = categorizePrompt("review the NDA contract terms and licensing policy");
		expect(result).toContain("legal-governance");
	});

	test("detects design-experience domain", () => {
		const result = categorizePrompt(
			"create figma wireframe for accessibility and responsive design",
		);
		expect(result).toContain("design-experience");
	});

	test("detects content-communications domain", () => {
		const result = categorizePrompt("write blog article and release notes for the newsletter");
		expect(result).toContain("content-communications");
	});
});

describe("getPrimaryDomain", () => {
	test("returns 'general' for prompt with no matching keywords", () => {
		const result = getPrimaryDomain("blorp zazzle plonk");
		expect(result).toBe("general");
	});

	test("returns 'product-engineering' for React/CSS prompt", () => {
		const result = getPrimaryDomain("build a React component with CSS");
		expect(result).toBe("product-engineering");
	});

	test("returns 'product-engineering' for API-related prompt", () => {
		const result = getPrimaryDomain("create REST API endpoint with express middleware");
		expect(result).toBe("product-engineering");
	});

	test("returns 'product-engineering' for SQL prompt", () => {
		const result = getPrimaryDomain("write a SQL migration for postgres schema");
		expect(result).toBe("product-engineering");
	});

	test("returns 'platform-infrastructure' for deployment prompt", () => {
		const result = getPrimaryDomain("set up docker kubernetes deployment with terraform");
		expect(result).toBe("platform-infrastructure");
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
	test("contains all 10 expected domains", () => {
		const domains = Object.keys(DEFAULT_DOMAIN_KEYWORDS);
		expect(domains).toContain("product-engineering");
		expect(domains).toContain("platform-infrastructure");
		expect(domains).toContain("security-compliance");
		expect(domains).toContain("data-intelligence");
		expect(domains).toContain("design-experience");
		expect(domains).toContain("content-communications");
		expect(domains).toContain("revenue-growth");
		expect(domains).toContain("customer-operations");
		expect(domains).toContain("strategy-finance");
		expect(domains).toContain("legal-governance");
		expect(Object.keys(DEFAULT_DOMAIN_KEYWORDS).length).toBe(10);
	});

	test("each domain has at least 5 keywords", () => {
		for (const [_domain, keywords] of Object.entries(DEFAULT_DOMAIN_KEYWORDS)) {
			expect(keywords.length).toBeGreaterThanOrEqual(5);
		}
	});

	test("product-engineering contains react", () => {
		expect(DEFAULT_DOMAIN_KEYWORDS["product-engineering"]).toContain("react");
	});

	test("product-engineering contains api", () => {
		expect(DEFAULT_DOMAIN_KEYWORDS["product-engineering"]).toContain("api");
	});

	test("product-engineering contains sql", () => {
		expect(DEFAULT_DOMAIN_KEYWORDS["product-engineering"]).toContain("sql");
	});

	test("platform-infrastructure contains docker", () => {
		expect(DEFAULT_DOMAIN_KEYWORDS["platform-infrastructure"]).toContain("docker");
	});
});


