import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RunnerEvent } from "@randal/core";
import { Runner } from "@randal/runner";
import type { CliContext } from "../cli.js";
import { parseArgs } from "../parse-args.js";

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
	const { flags, positionals } = parseArgs(args, {
		string: ["agent", "model", "workdir"],
		number: ["max-iterations"],
		boolean: ["verbose", "no-memory"],
		aliases: { "-v": "--verbose" },
		passthrough: ["config", "url"],
	});

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

	return {
		prompt,
		agent: flags.agent as string | undefined,
		model: flags.model as string | undefined,
		maxIterations: flags["max-iterations"] as number | undefined,
		workdir: flags.workdir as string | undefined,
		verbose: (flags.verbose as boolean) ?? false,
	};
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
