import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * randal deploy — Deploy to Railway
 *
 * Subcommands:
 *   agent   Deploy a single agent to Railway
 *   posse   Deploy a multi-agent posse to Railway
 *   env     Set environment variables on Railway (no deploy)
 *   list    List deployed posses
 *   delete  Delete a deployed posse
 */
export async function deployCommand(args: string[]): Promise<void> {
	const sub = args[0];

	if (!sub || sub === "--help" || sub === "-h") {
		printHelp();
		return;
	}

	switch (sub) {
		case "agent":
			await deployAgent(args.slice(1));
			break;
		case "posse":
			await deployPosse(args.slice(1));
			break;
		case "env":
			await deployEnv(args.slice(1));
			break;
		case "list":
			await deployList(args.slice(1));
			break;
		case "delete":
			await deployDelete(args.slice(1));
			break;
		default:
			console.error(`Unknown deploy subcommand: ${sub}`);
			printHelp();
			process.exit(1);
	}
}

function printHelp(): void {
	console.log(`
  randal deploy — Deploy to Railway

  Subcommands:
    agent [options]                         Deploy a single agent to Railway
    posse --name <name> [--config <file>]   Deploy a multi-agent posse to Railway
    env [options]                           Set environment variables only (no deploy)
    list                                    List deployed posses
    delete <name> [--force]                 Delete a deployed posse

  Agent options:
    --dry-run           Preview without deploying

  Posse options:
    --name <name>       Posse name (required)
    --config <file>     Posse config YAML (default: examples/railway-posse/full-company.yaml)
    --dry-run           Preview without deploying

  Env options:
    --env-file <path>   Path to .env file (default: .env)
    --verbose           Show variable names being set

  Examples:
    randal deploy agent                     Deploy single agent from current directory
    randal deploy agent --dry-run           Preview single agent deploy
    randal deploy posse --name my-team      Deploy posse with default config
    randal deploy posse --name my-team --config my-posse.yaml
    randal deploy env                       Set Railway env vars from .env
    randal deploy list                      List deployed posses
    randal deploy delete my-team            Delete a posse
`);
}

/** Resolve the path to a script in the scripts/ directory */
function resolveScript(name: string): string {
	// Try relative to cwd first (running from repo root)
	const fromCwd = resolve(process.cwd(), "scripts", name);
	if (existsSync(fromCwd)) return fromCwd;

	// Try relative to this file (installed via workspace)
	const fromPkg = resolve(import.meta.dir, "../../../../scripts", name);
	if (existsSync(fromPkg)) return fromPkg;

	// Try RANDAL_HOME env var
	const home = process.env.RANDAL_HOME;
	if (home) {
		const fromHome = resolve(home, "scripts", name);
		if (existsSync(fromHome)) return fromHome;
	}

	console.error(`Could not find script: scripts/${name}`);
	console.error("Make sure you're running from the Randal repo root,");
	console.error("or set RANDAL_HOME to your Randal installation directory.");
	process.exit(1);
}

/** Check that a required tool is available */
function checkTool(name: string, installHint: string): void {
	const result = Bun.spawnSync(["which", name]);
	if (result.exitCode !== 0) {
		console.error(`Required tool not found: ${name}`);
		console.error(`Install it with: ${installHint}`);
		process.exit(1);
	}
}

/** Run a script with args, streaming stdout/stderr to the terminal */
async function runScript(scriptPath: string, scriptArgs: string[]): Promise<void> {
	const proc = Bun.spawn(["bash", scriptPath, ...scriptArgs], {
		cwd: resolve(scriptPath, "../.."), // scripts/ is one level under project root
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env },
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}

async function deployAgent(args: string[]): Promise<void> {
	checkTool("railway", "curl -fsSL https://railway.com/install.sh | sh");

	const scriptPath = resolveScript("deploy-railway.sh");
	await runScript(scriptPath, args);
}

async function deployPosse(args: string[]): Promise<void> {
	checkTool("railway", "curl -fsSL https://railway.com/install.sh | sh");
	checkTool("yq", "brew install yq");
	checkTool("jq", "brew install jq");

	// Validate --name is provided
	const nameIdx = args.indexOf("--name");
	if (nameIdx === -1 || !args[nameIdx + 1]) {
		console.error("Error: --name is required for posse deployment");
		console.error("Usage: randal deploy posse --name <name> [--config <file>]");
		process.exit(1);
	}

	const scriptPath = resolveScript("deploy-railway-posse.sh");
	await runScript(scriptPath, args);
}

async function deployEnv(args: string[]): Promise<void> {
	checkTool("railway", "curl -fsSL https://railway.com/install.sh | sh");

	const scriptPath = resolveScript("set-railway-env.sh");
	await runScript(scriptPath, args);
}

async function deployList(_args: string[]): Promise<void> {
	const scriptPath = resolveScript("list-railway-posses.sh");
	await runScript(scriptPath, []);
}

async function deployDelete(args: string[]): Promise<void> {
	const name = args.find((a) => !a.startsWith("-"));
	if (!name) {
		console.error("Error: posse name is required");
		console.error("Usage: randal deploy delete <name> [--force]");
		process.exit(1);
	}

	const scriptPath = resolveScript("delete-railway-posse.sh");
	await runScript(scriptPath, args);
}
