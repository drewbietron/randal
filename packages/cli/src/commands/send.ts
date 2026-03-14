import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CliContext } from "../cli.js";

export async function sendCommand(args: string[], ctx: CliContext): Promise<void> {
	let prompt: string | undefined;
	let agent: string | undefined;
	let model: string | undefined;
	let maxIterations: number | undefined;
	let workdir: string | undefined;

	const url = ctx.url ?? "http://localhost:7600";

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--agent") agent = args[++i];
		else if (arg === "--model") model = args[++i];
		else if (arg === "--max-iterations") maxIterations = Number.parseInt(args[++i], 10);
		else if (arg === "--workdir") workdir = args[++i];
		else if (arg === "--url" || arg === "--config") i++;
		else if (!arg.startsWith("-") && !prompt) {
			const resolved = resolve(arg);
			if (existsSync(resolved) && arg.endsWith(".md")) {
				prompt = readFileSync(resolved, "utf-8");
			} else {
				prompt = arg;
			}
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
