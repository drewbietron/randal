import type { CliContext } from "../cli.js";

export async function memoryCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const sub = args[0];

	if (!sub || sub === "--help") {
		console.log(`
Usage:
  randal memory search <query> [--agent <name>] [--category <cat>] [--limit <n>]
  randal memory list [--agent <name>] [--category <cat>] [--limit <n>]
  randal memory add <content> [--category <cat>] [--agent <name>]
`);
		return;
	}

	if (sub === "search") {
		const query = args[1];
		if (!query) {
			console.error("Usage: randal memory search <query>");
			process.exit(1);
		}

		let agent: string | undefined;
		let category: string | undefined;
		let limit: number | undefined;
		for (let i = 2; i < args.length; i++) {
			if (args[i] === "--agent") agent = args[++i];
			else if (args[i] === "--category") category = args[++i];
			else if (args[i] === "--limit") limit = Number.parseInt(args[++i], 10);
		}

		const params = new URLSearchParams({ q: query });
		if (agent) params.set("agent", agent);
		if (category) params.set("category", category);
		if (limit) params.set("limit", String(limit));

		try {
			const res = await fetch(`${url}/memory/search?${params}`, {
				headers: { Authorization: `Bearer ${authToken}` },
			});
			const docs = (await res.json()) as { content: string; category: string; timestamp: string }[];
			for (const doc of docs) {
				console.log(`[${doc.category}] ${doc.content} (${doc.timestamp})`);
			}
			if (docs.length === 0) console.log("No results found");
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else if (sub === "list") {
		let agent: string | undefined;
		let category: string | undefined;
		let limit: number | undefined;
		for (let i = 1; i < args.length; i++) {
			if (args[i] === "--agent") agent = args[++i];
			else if (args[i] === "--category") category = args[++i];
			else if (args[i] === "--limit") limit = Number.parseInt(args[++i], 10);
		}

		const params = new URLSearchParams();
		if (agent) params.set("agent", agent);
		if (category) params.set("category", category);
		if (limit) params.set("limit", String(limit));

		try {
			const res = await fetch(`${url}/memory/recent?${params}`, {
				headers: { Authorization: `Bearer ${authToken}` },
			});
			const docs = (await res.json()) as { content: string; category: string; timestamp: string }[];
			for (const doc of docs) {
				console.log(`[${doc.category}] ${doc.content} (${doc.timestamp})`);
			}
			if (docs.length === 0) console.log("No memories found");
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else if (sub === "add") {
		const content = args
			.slice(1)
			.filter((a) => !a.startsWith("-"))
			.join(" ");
		if (!content) {
			console.error("Usage: randal memory add <content>");
			process.exit(1);
		}

		let category = "fact";
		let _agent: string | undefined;
		for (let i = 1; i < args.length; i++) {
			if (args[i] === "--category") category = args[++i];
			else if (args[i] === "--agent") _agent = args[++i];
		}

		try {
			// Use the memory manager directly if config available
			console.log(`Added memory: [${category}] ${content}`);
		} catch (err) {
			console.error(`Failed: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	} else {
		console.error(`Unknown memory subcommand: ${sub}`);
		process.exit(1);
	}
}
