import { loadConfig } from "@randal/core";
import type { RandalConfig } from "@randal/core";

export interface CliContext {
	config: RandalConfig;
	configPath?: string;
	url?: string;
}

function printHelp(): void {
	console.log(`
  🤠 \x1b[1mrandal\x1b[0m v0.2 — agent harness
  \x1b[2mThe composable harness for autonomous AI agent posses.\x1b[0m

  \x1b[1mUsage:\x1b[0m
    randal <command> [options]

  \x1b[1mCommands:\x1b[0m
    \x1b[36minit\x1b[0m                    🔧 Scaffold config (--wizard, --from, --yes)
    \x1b[36mrun\x1b[0m <prompt|file>      🎯 Run agent locally (one-shot)
    \x1b[36mserve\x1b[0m                   🏗️  Start daemon (gateway + runner + scheduler)
    \x1b[36msend\x1b[0m <prompt|file>     📨 Submit job to running instance
    \x1b[36mstatus\x1b[0m [job-id]        📊 Get job status
    \x1b[36mjobs\x1b[0m                    📋 List all jobs
    \x1b[36mstop\x1b[0m <job-id>          🛑 Stop a running job
    \x1b[36mcontext\x1b[0m <text>         💉 Inject context into running job
    \x1b[36mresume\x1b[0m <job-id>        🔄 Resume a failed job
    \x1b[36mmemory\x1b[0m <sub>           🧠 Memory operations (search, list, add)
    \x1b[36mskills\x1b[0m <sub>           📚 Skill management (list, search, show)
    \x1b[36mcron\x1b[0m <sub>             📅 Cron job management (list, add, remove)
    \x1b[36mheartbeat\x1b[0m <sub>        💓 Heartbeat control (status, trigger)

  \x1b[1mGlobal options:\x1b[0m
    --config <path>       Path to config file
    --url <url>           Remote server URL
    --version             Show version
    --help                Show help

  \x1b[2mDocs: docs/cli-reference.md\x1b[0m
`);
}

function printVersion(): void {
	console.log("🤠 randal v0.2.0");
}

export async function run(argv: string[]): Promise<void> {
	const args = argv.slice(2); // strip bun/node + script path
	const command = args[0];

	// Global flags
	if (!command || command === "--help" || command === "-h") {
		printHelp();
		return;
	}

	if (command === "--version" || command === "-v") {
		printVersion();
		return;
	}

	// Find --config flag
	const configIdx = args.indexOf("--config");
	const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

	// Find --url flag
	const urlIdx = args.indexOf("--url");
	const url = urlIdx !== -1 ? args[urlIdx + 1] : undefined;

	// Commands that don't need config
	if (command === "init") {
		const { initCommand } = await import("./commands/init.js");
		await initCommand(args.slice(1));
		return;
	}

	// Load config for commands that need it
	let config: RandalConfig;
	try {
		config = loadConfig(configPath);
	} catch (err) {
		// Some commands work without config when using --url
		if (
			url &&
			[
				"send",
				"status",
				"jobs",
				"stop",
				"context",
				"resume",
				"memory",
				"skills",
				"cron",
				"heartbeat",
			].includes(command)
		) {
			config = null as unknown as RandalConfig;
		} else {
			console.error(`Error: ${err instanceof Error ? err.message : "Failed to load config"}`);
			process.exit(1);
		}
	}

	const ctx: CliContext = { config, configPath, url };

	switch (command) {
		case "run": {
			const { runCommand } = await import("./commands/run.js");
			await runCommand(args.slice(1), ctx);
			break;
		}
		case "serve": {
			const { serveCommand } = await import("./commands/serve.js");
			await serveCommand(args.slice(1), ctx);
			break;
		}
		case "send": {
			const { sendCommand } = await import("./commands/send.js");
			await sendCommand(args.slice(1), ctx);
			break;
		}
		case "status": {
			const { statusCommand } = await import("./commands/status.js");
			await statusCommand(args.slice(1), ctx);
			break;
		}
		case "jobs": {
			const { jobsCommand } = await import("./commands/jobs.js");
			await jobsCommand(args.slice(1), ctx);
			break;
		}
		case "stop": {
			const { stopCommand } = await import("./commands/stop.js");
			await stopCommand(args.slice(1), ctx);
			break;
		}
		case "context": {
			const { contextCommand } = await import("./commands/context.js");
			await contextCommand(args.slice(1), ctx);
			break;
		}
		case "resume": {
			const { resumeCommand } = await import("./commands/resume.js");
			await resumeCommand(args.slice(1), ctx);
			break;
		}
		case "memory": {
			const { memoryCommand } = await import("./commands/memory.js");
			await memoryCommand(args.slice(1), ctx);
			break;
		}
		case "skills": {
			const { skillsCommand } = await import("./commands/skills.js");
			await skillsCommand(args.slice(1), ctx);
			break;
		}
		case "cron": {
			const { cronCommand } = await import("./commands/cron.js");
			await cronCommand(args.slice(1), ctx);
			break;
		}
		case "heartbeat": {
			const { heartbeatCommand } = await import("./commands/heartbeat.js");
			await heartbeatCommand(args.slice(1), ctx);
			break;
		}
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			process.exit(1);
	}
}
