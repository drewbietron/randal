import type { CliContext } from "../cli.js";

export async function skillsCommand(args: string[], ctx: CliContext): Promise<void> {
	const subcommand = args[0];

	if (!subcommand || subcommand === "--help" || subcommand === "-h") {
		console.log(`
randal skills - Skill management

Subcommands:
  list              List all skills
  search <query>    Search skills by relevance
  show <name>       Show skill content
`);
		return;
	}

	const url = ctx.url ?? "http://localhost:7600";
	const authHeader = getAuthHeader(ctx);

	switch (subcommand) {
		case "list":
			await listSkills(url, authHeader);
			break;
		case "search":
			await searchSkills(args[1], url, authHeader);
			break;
		case "show":
			await showSkill(args[1], url, authHeader);
			break;
		default:
			console.error(`Unknown skills subcommand: ${subcommand}`);
			process.exit(1);
	}
}

function getAuthHeader(ctx: CliContext): Record<string, string> {
	if (!ctx.config) return {};
	const httpChannel = ctx.config.gateway.channels.find((c) => c.type === "http");
	const token = httpChannel?.type === "http" ? httpChannel.auth : undefined;
	if (token) {
		return { Authorization: `Bearer ${token}` };
	}
	return {};
}

async function listSkills(url: string, headers: Record<string, string>): Promise<void> {
	try {
		const res = await fetch(`${url}/skills`, { headers });
		if (!res.ok) {
			console.error(`Error: ${res.status} ${res.statusText}`);
			return;
		}

		const skills = (await res.json()) as Array<{
			name: string;
			description: string;
			tags: string[];
			version?: number;
			updated: string;
		}>;

		if (skills.length === 0) {
			console.log("No skills found.");
			return;
		}

		console.log(`Skills (${skills.length}):\n`);
		for (const skill of skills) {
			const tags = skill.tags.length > 0 ? ` [${skill.tags.join(", ")}]` : "";
			const version = skill.version ? ` v${skill.version}` : "";
			console.log(`  ${skill.name}${version}${tags}`);
			console.log(`    ${skill.description}`);
		}
	} catch (err) {
		console.error(`Failed to connect to ${url}:`, err instanceof Error ? err.message : String(err));
	}
}

async function searchSkills(
	query: string | undefined,
	url: string,
	headers: Record<string, string>,
): Promise<void> {
	if (!query) {
		console.error("Usage: randal skills search <query>");
		process.exit(1);
	}

	try {
		const res = await fetch(`${url}/skills/search?q=${encodeURIComponent(query)}`, { headers });
		if (!res.ok) {
			console.error(`Error: ${res.status} ${res.statusText}`);
			return;
		}

		const results = (await res.json()) as Array<{
			name: string;
			description: string;
			tags: string[];
		}>;

		if (results.length === 0) {
			console.log(`No skills found for "${query}".`);
			return;
		}

		console.log(`Results for "${query}" (${results.length}):\n`);
		for (const skill of results) {
			const tags = skill.tags.length > 0 ? ` [${skill.tags.join(", ")}]` : "";
			console.log(`  ${skill.name}${tags}`);
			console.log(`    ${skill.description}`);
		}
	} catch (err) {
		console.error(`Failed to connect to ${url}:`, err instanceof Error ? err.message : String(err));
	}
}

async function showSkill(
	name: string | undefined,
	url: string,
	headers: Record<string, string>,
): Promise<void> {
	if (!name) {
		console.error("Usage: randal skills show <name>");
		process.exit(1);
	}

	try {
		const res = await fetch(`${url}/skills/${encodeURIComponent(name)}`, { headers });
		if (!res.ok) {
			if (res.status === 404) {
				console.error(`Skill "${name}" not found.`);
			} else {
				console.error(`Error: ${res.status} ${res.statusText}`);
			}
			return;
		}

		const skill = (await res.json()) as {
			name: string;
			description: string;
			tags: string[];
			requires?: { env?: string[]; binaries?: string[] };
			version?: number;
			content: string;
			filePath: string;
			updated: string;
		};

		console.log(`# ${skill.name}`);
		console.log(`Description: ${skill.description}`);
		if (skill.tags.length > 0) console.log(`Tags: ${skill.tags.join(", ")}`);
		if (skill.version) console.log(`Version: ${skill.version}`);
		if (skill.requires?.env?.length) console.log(`Requires env: ${skill.requires.env.join(", ")}`);
		if (skill.requires?.binaries?.length)
			console.log(`Requires binaries: ${skill.requires.binaries.join(", ")}`);
		console.log(`File: ${skill.filePath}`);
		console.log(`Updated: ${skill.updated}`);
		console.log("");
		console.log(skill.content);
	} catch (err) {
		console.error(`Failed to connect to ${url}:`, err instanceof Error ? err.message : String(err));
	}
}
