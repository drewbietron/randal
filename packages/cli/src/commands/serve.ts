import type { CliContext } from "../cli.js";

export async function serveCommand(args: string[], ctx: CliContext): Promise<void> {
	const { startGateway } = await import("@randal/gateway");

	let port: number | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port") {
			port = Number.parseInt(args[++i], 10);
		}
	}

	await startGateway({ config: ctx.config, port });
}
