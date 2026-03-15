import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RunnerEvent } from "@randal/core";
import { Runner } from "@randal/runner";
import type { CliContext } from "../cli.js";

export interface ParsedRunArgs {
	prompt?: string;
	agent?: string;
	model?: string;
	maxIterations?: number;
	workdir?: string;
	verbose: boolean;
}

/**
 * Parse run command arguments into a structured object.
 * Exported for testing.
 */
export function parseRunArgs(args: string[]): ParsedRunArgs {
	let prompt: string | undefined;
	let agent: string | undefined;
	let model: string | undefined;
	let maxIterations: number | undefined;
	let workdir: string | undefined;
	let verbose = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--agent") {
			agent = args[++i];
		} else if (arg === "--model") {
			model = args[++i];
		} else if (arg === "--max-iterations") {
			maxIterations = Number.parseInt(args[++i], 10);
		} else if (arg === "--workdir") {
			workdir = args[++i];
		} else if (arg === "--verbose" || arg === "-v") {
			verbose = true;
		} else if (arg === "--config" || arg === "--url") {
			i++; // skip value for global flags that take a value
		} else if (arg === "--no-memory") {
			// Boolean flag — do not increment i
		} else if (!arg.startsWith("-") && !prompt) {
			// Check if it's a file path
			const resolved = resolve(arg);
			if (existsSync(resolved) && arg.endsWith(".md")) {
				prompt = readFileSync(resolved, "utf-8");
			} else {
				prompt = arg;
			}
		}
	}

	return { prompt, agent, model, maxIterations, workdir, verbose };
}

export async function runCommand(args: string[], ctx: CliContext): Promise<void> {
	const { prompt, agent, model, maxIterations, workdir, verbose } = parseRunArgs(args);

	if (!prompt) {
		console.error("Usage: randal run <prompt|file> [options]");
		process.exit(1);
	}

	const onEvent = (event: RunnerEvent): void => {
		switch (event.type) {
			case "job.started":
				console.log(`Job ${event.jobId} started`);
				break;
			case "iteration.start":
				console.log(`  Iteration ${event.data.iteration}/${event.data.maxIterations}`);
				break;
			case "iteration.end":
				if (verbose && event.data.summary) {
					console.log(`    ${event.data.summary}`);
				}
				if (event.data.filesChanged?.length) {
					console.log(`    Files: ${event.data.filesChanged.join(", ")}`);
				}
				break;
			case "job.stuck":
				console.log(`  ⚠ Stuck: ${event.data.struggleIndicators?.join(", ")}`);
				break;
			case "job.complete":
				console.log(
					`Job ${event.jobId} complete (${event.data.iteration} iterations, ${event.data.duration}s)`,
				);
				break;
			case "job.failed":
				console.error(`Job ${event.jobId} failed: ${event.data.error}`);
				break;
			case "job.stopped":
				console.log(`Job ${event.jobId} stopped`);
				break;
		}
	};

	const runner = new Runner({
		config: ctx.config,
		onEvent,
	});

	const job = await runner.execute({
		prompt,
		agent,
		model,
		maxIterations,
		workdir,
	});

	if (job.status === "failed") {
		process.exit(1);
	}
}
