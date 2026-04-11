import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CliContext } from "../cli.js";
import { parseArgs } from "../parse-args.js";

export async function sendCommand(args: string[], ctx: CliContext): Promise<void> {
	const { flags, positionals } = parseArgs(args, {
		string: ["agent", "model", "workdir"],
		number: ["max-iterations"],
		passthrough: ["config", "url"],
	});

	const agent = flags.agent as string | undefined;
	const model = flags.model as string | undefined;
	const maxIterations = flags["max-iterations"] as number | undefined;
	const workdir = flags.workdir as string | undefined;
	const url = ctx.url ?? "http://localhost:7600";

	let prompt: string | undefined;
	if (positionals.length > 0) {
		const first = positionals[0];
		const resolved = resolve(first);
		if (existsSync(resolved) && first.endsWith(".md")) {
			prompt = readFileSync(resolved, "utf-8");
		} else {
			prompt = first;
		}
	}

	if (!prompt) {
		console.error("Usage: randal send <prompt|file> [options]");
		process.exit(1);
	}

	// Get auth token from config or env
	const authToken = process.env.RANDAL_API_TOKEN ?? "";

	const body: Record<string, unknown> = { prompt };
	if (agent) body.agent = agent;
	if (model) body.model = model;
	if (maxIterations) body.maxIterations = maxIterations;
	if (workdir) body.workdir = workdir;

	try {
		const res = await fetch(`${url}/job`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authToken}`,
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			console.error(`Error: ${res.status} ${res.statusText}`);
			const text = await res.text();
			if (text) console.error(text);
			process.exit(1);
		}

		const data = (await res.json()) as { id: string; status: string };
		console.log(`Job submitted: ${data.id} (${data.status})`);
	} catch (err) {
		console.error(`Failed to connect to ${url}: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
