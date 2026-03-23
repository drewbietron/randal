import { loadConfig } from "@randal/core";
import type { CliContext } from "../cli.js";

/**
 * Auto-start Meilisearch if the config uses it and it's not already running.
 * Generates MEILI_MASTER_KEY in .env if missing.
 * Returns true if .env was modified (config needs reload).
 */
async function ensureMeilisearch(ctx: CliContext): Promise<boolean> {
	if (ctx.config.memory.store !== "meilisearch") return false;

	const url = ctx.config.memory.url || "http://localhost:7700";
	let envModified = false;

	// Resolve master key: check env, generate if missing
	let masterKey = process.env.MEILI_MASTER_KEY;
	if (!masterKey) {
		const { randomBytes } = await import("node:crypto");
		masterKey = randomBytes(16).toString("hex");

		// Persist to .env
		const { resolve, dirname } = await import("node:path");
		const basePath = ctx.configPath ? dirname(resolve(ctx.configPath)) : ".";
		const envPath = resolve(basePath, ".env");
		const fs = await import("node:fs");
		let envContent = "";
		try {
			envContent = fs.readFileSync(envPath, "utf-8");
		} catch {
			// No .env yet
		}

		if (envContent.includes("MEILI_MASTER_KEY=")) {
			envContent = envContent.replace(
				/^#?\s*MEILI_MASTER_KEY=.*$/m,
				`MEILI_MASTER_KEY=${masterKey}`,
			);
		} else {
			envContent += `\nMEILI_MASTER_KEY=${masterKey}\n`;
		}
		fs.writeFileSync(envPath, envContent);
		process.env.MEILI_MASTER_KEY = masterKey;
		envModified = true;
		console.log("  + Generated MEILI_MASTER_KEY in .env");
	}

	// Check if already running
	try {
		const res = await fetch(`${url}/health`);
		if (res.ok) return envModified;
	} catch {
		// Not running — start it
	}

	// Find meilisearch binary
	const which = Bun.spawnSync(["which", "meilisearch"]);
	if (which.exitCode !== 0) {
		console.log("\x1b[33mMeilisearch not found. Install with: brew install meilisearch\x1b[0m");
		return envModified;
	}
	const binary = which.stdout.toString().trim();

	// Start meilisearch in background
	const { mkdirSync } = await import("node:fs");
	const { resolve } = await import("node:path");
	const dbPath = resolve(process.env.HOME ?? ".", ".randal/meili-data");
	mkdirSync(dbPath, { recursive: true });

	console.log("  Starting Meilisearch...");
	const proc = Bun.spawn([binary, "--db-path", dbPath, "--master-key", masterKey], {
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	proc.unref();

	// Wait for it to be ready (up to 5s)
	for (let i = 0; i < 25; i++) {
		await Bun.sleep(200);
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) {
				console.log(`  + Meilisearch running on ${url}`);
				return envModified;
			}
		} catch {
			// Not ready yet
		}
	}
	console.log("\x1b[33m  ! Meilisearch failed to start within 5s\x1b[0m");
	return envModified;
}

export async function serveCommand(args: string[], ctx: CliContext): Promise<void> {
	const { startGateway } = await import("@randal/gateway");

	let port: number | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port") {
			port = Number.parseInt(args[++i], 10);
		}
	}

	// Startup update check
	if (ctx.config.updates?.autoCheck) {
		try {
			const { checkForUpdate } = await import("./update.js");
			const update = await checkForUpdate(ctx.config.updates.channel);
			if (update.available) {
				console.log(`\x1b[33mUpdate available: ${update.current} -> ${update.latest}\x1b[0m`);
				console.log("\x1b[2mRun 'randal update' to apply.\x1b[0m\n");
			}
		} catch {
			// Update check failed -- don't block startup
		}
	}

	// Auto-start Meilisearch if needed
	const envChanged = await ensureMeilisearch(ctx);

	// Reload config if .env was modified (so new keys are substituted)
	let config = ctx.config;
	if (envChanged) {
		config = loadConfig(ctx.configPath);
	}

	await startGateway({ config, port });
}
