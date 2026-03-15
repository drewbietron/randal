import type { CliContext } from "../cli.js";

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

	await startGateway({ config: ctx.config, port });
}
