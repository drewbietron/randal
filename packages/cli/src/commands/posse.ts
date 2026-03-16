import type { CliContext } from "../cli.js";

export async function posseCommand(args: string[], ctx: CliContext): Promise<void> {
	const subcommand = args[0];
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";

	const apiHeaders = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${authToken}`,
	};

	if (!subcommand || subcommand === "--help") {
		console.log(`
  randal posse — Posse coordination commands

  Subcommands:
    status              Show posse status (agents, heartbeats)
    agents              List posse agents with capabilities
    memory search       Search posse memory

  Options:
    --url <url>         Remote server URL (default: http://localhost:7600)
`);
		return;
	}

	if (subcommand === "status") {
		try {
			const res = await fetch(`${url}/posse`, { headers: apiHeaders });
			if (!res.ok) {
				if (res.status === 404) {
					console.log("This agent is not a posse member.");
					return;
				}
				console.error(`Error: ${res.status} ${res.statusText}`);
				return;
			}

			const data = (await res.json()) as {
				posse: string;
				self: string;
				agents: Array<{
					name: string;
					status: string;
					agent: string;
					version: string;
					lastHeartbeat: string;
				}>;
			};

			console.log(`Posse: ${data.posse}`);
			console.log(`Self: ${data.self}`);
			console.log("");

			if (data.agents.length === 0) {
				console.log("No agents registered.");
				return;
			}

			console.log("Agents:");
			for (const agent of data.agents) {
				const staleMarker = agent.status === "stale" ? " [STALE]" : "";
				const selfMarker = agent.name === data.self ? " (self)" : "";
				const heartbeat = agent.lastHeartbeat
					? new Date(agent.lastHeartbeat).toLocaleString()
					: "-";
				console.log(
					`  ${agent.name}${selfMarker}  status=${agent.status}${staleMarker}  heartbeat=${heartbeat}`,
				);
			}
		} catch (err) {
			console.error(`Failed to connect to ${url}: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
		return;
	}

	if (subcommand === "agents") {
		try {
			const res = await fetch(`${url}/posse`, { headers: apiHeaders });
			if (!res.ok) {
				if (res.status === 404) {
					console.log("This agent is not a posse member.");
					return;
				}
				console.error(`Error: ${res.status} ${res.statusText}`);
				return;
			}

			const data = (await res.json()) as {
				agents: Array<{
					name: string;
					agent: string;
					version: string;
					capabilities: string[];
					status: string;
				}>;
			};

			if (data.agents.length === 0) {
				console.log("No agents registered.");
				return;
			}

			for (const agent of data.agents) {
				console.log(`${agent.name}`);
				console.log(`  Agent: ${agent.agent}`);
				console.log(`  Version: ${agent.version}`);
				console.log(`  Status: ${agent.status}`);
				console.log(
					`  Capabilities: ${agent.capabilities.length > 0 ? agent.capabilities.join(", ") : "none"}`,
				);
				console.log("");
			}
		} catch (err) {
			console.error(`Failed to connect to ${url}: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
		return;
	}

	if (subcommand === "memory") {
		const memSub = args[1];
		if (memSub !== "search") {
			console.error('Usage: randal posse memory search "<query>" [--scope all|shared|self]');
			process.exit(1);
		}

		// Find query string
		let query: string | undefined;
		let scope = "all";
		for (let i = 2; i < args.length; i++) {
			if (args[i] === "--scope") {
				scope = args[++i] ?? "all";
			} else if (args[i] === "--url" || args[i] === "--config") {
				i++; // skip value
			} else if (!args[i].startsWith("-") && !query) {
				query = args[i];
			}
		}

		if (!query) {
			console.error('Usage: randal posse memory search "<query>" [--scope all|shared|self]');
			process.exit(1);
		}

		try {
			const res = await fetch(
				`${url}/posse/memory/search?q=${encodeURIComponent(query)}&scope=${scope}`,
				{ headers: apiHeaders },
			);

			if (!res.ok) {
				if (res.status === 404) {
					console.log("This agent is not a posse member.");
					return;
				}
				console.error(`Error: ${res.status} ${res.statusText}`);
				return;
			}

			const results = (await res.json()) as Array<{
				content: string;
				category: string;
				source: string;
				timestamp: string;
			}>;

			if (results.length === 0) {
				console.log("No results found.");
				return;
			}

			for (const doc of results) {
				const source = doc.source !== "self" ? ` (${doc.source})` : "";
				console.log(`[${doc.category}]${source} ${doc.content}`);
			}
		} catch (err) {
			console.error(`Failed to connect to ${url}: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
		return;
	}

	console.error(`Unknown posse subcommand: ${subcommand}`);
	console.error("Try: randal posse --help");
	process.exit(1);
}
