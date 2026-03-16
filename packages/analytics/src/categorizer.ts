/**
 * Domain categorizer — assigns task categories based on keyword matching.
 * R5.6: Automatic domain categorization without ML models.
 */

export const DEFAULT_DOMAIN_KEYWORDS: Record<string, string[]> = {
	frontend: [
		"react",
		"vue",
		"angular",
		"css",
		"html",
		"component",
		"ui",
		"ux",
		"tailwind",
		"next.js",
		"svelte",
		"dom",
		"browser",
		"jsx",
		"tsx",
		"styled",
		"sass",
		"less",
		"webpack",
		"vite",
		"button",
		"form",
		"layout",
		"responsive",
		"animation",
	],
	backend: [
		"api",
		"server",
		"endpoint",
		"rest",
		"graphql",
		"middleware",
		"express",
		"hono",
		"fastify",
		"route",
		"handler",
		"controller",
		"service",
		"authentication",
		"authorization",
		"jwt",
		"oauth",
		"websocket",
		"http",
		"cors",
	],
	database: [
		"sql",
		"query",
		"migration",
		"schema",
		"postgres",
		"mysql",
		"sqlite",
		"prisma",
		"drizzle",
		"mongodb",
		"redis",
		"index",
		"table",
		"column",
		"foreign key",
		"join",
		"orm",
		"seed",
		"transaction",
	],
	infra: [
		"docker",
		"kubernetes",
		"ci",
		"cd",
		"deploy",
		"terraform",
		"aws",
		"gcp",
		"azure",
		"nginx",
		"load balancer",
		"ssl",
		"certificate",
		"dns",
		"monitoring",
		"logging",
		"k8s",
		"container",
		"pipeline",
		"github actions",
	],
	docs: [
		"readme",
		"documentation",
		"docs",
		"guide",
		"tutorial",
		"changelog",
		"comment",
		"jsdoc",
		"typedoc",
		"api reference",
		"architecture",
	],
	testing: [
		"test",
		"spec",
		"jest",
		"vitest",
		"cypress",
		"playwright",
		"coverage",
		"mock",
		"stub",
		"fixture",
		"assertion",
		"e2e",
		"integration test",
		"unit test",
		"snapshot",
	],
};

/**
 * Categorize a prompt text into domains based on keyword matching.
 * Returns all matching domains, sorted by match count (highest first).
 */
export function categorizePrompt(
	prompt: string,
	domainKeywords: Record<string, string[]> = DEFAULT_DOMAIN_KEYWORDS,
): string[] {
	const lower = prompt.toLowerCase();
	const scores: { domain: string; count: number }[] = [];

	for (const [domain, keywords] of Object.entries(domainKeywords)) {
		let count = 0;
		for (const keyword of keywords) {
			if (lower.includes(keyword.toLowerCase())) {
				count++;
			}
		}
		if (count > 0) {
			scores.push({ domain, count });
		}
	}

	// Sort by count descending
	scores.sort((a, b) => b.count - a.count);

	return scores.map((s) => s.domain);
}

/**
 * Get the primary domain for a prompt.
 * Returns "general" if no specific domain matched.
 */
export function getPrimaryDomain(
	prompt: string,
	domainKeywords: Record<string, string[]> = DEFAULT_DOMAIN_KEYWORDS,
): string {
	const domains = categorizePrompt(prompt, domainKeywords);
	return domains[0] ?? "general";
}
