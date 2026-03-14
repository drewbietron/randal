import type { CliContext } from "../cli.js";

function authHeaders(ctx: CliContext): Record<string, string> {
	const httpChannel = ctx.config?.gateway?.channels?.find((c) => c.type === "http");
	const token = httpChannel?.type === "http" ? httpChannel.auth : undefined;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function getUrl(ctx: CliContext): string {
	if (ctx.url) return ctx.url;
	const httpChannel = ctx.config?.gateway?.channels?.find((c) => c.type === "http");
	const port = httpChannel?.type === "http" ? httpChannel.port : 7600;
	return `http://localhost:${port}`;
}

export async function heartbeatCommand(args: string[], ctx: CliContext): Promise<void> {
	const subcommand = args[0];
	const url = getUrl(ctx);
	const headers = authHeaders(ctx);

	switch (subcommand) {
		case "status": {
			const res = await fetch(`${url}/scheduler`, { headers });
			if (!res.ok) {
				console.error(`Error: ${res.status} ${res.statusText}`);
				return;
			}
			const status = (await res.json()) as {
				heartbeat: {
					lastTick: string | null;
					nextTick: string | null;
					tickCount: number;
					pendingWakeItems: Array<{ text: string; source: string }>;
				};
				hooks: { enabled: boolean; pendingItems: number };
			};

			console.log("Heartbeat Status:");
			console.log("-".repeat(40));
			console.log(`  Last Tick:  ${status.heartbeat.lastTick ?? "never"}`);
			console.log(`  Next Tick:  ${status.heartbeat.nextTick ?? "stopped"}`);
			console.log(`  Tick Count: ${status.heartbeat.tickCount}`);
			console.log(`  Pending:    ${status.heartbeat.pendingWakeItems.length} wake item(s)`);

			if (status.heartbeat.pendingWakeItems.length > 0) {
				console.log("");
				console.log("  Pending Items:");
				for (const item of status.heartbeat.pendingWakeItems) {
					console.log(`    - [${item.source}] ${item.text.slice(0, 80)}`);
				}
			}

			console.log("");
			console.log(`  Hooks Enabled: ${status.hooks.enabled}`);
			break;
		}

		case "trigger": {
			const res = await fetch(`${url}/heartbeat/trigger`, {
				method: "POST",
				headers,
			});

			if (!res.ok) {
				const err = await res.json();
				console.error(`Error: ${(err as { error?: string }).error ?? res.statusText}`);
				return;
			}

			console.log("Heartbeat triggered.");
			break;
		}

		default:
			console.log("Usage: randal heartbeat <status|trigger>");
			console.log("");
			console.log("Commands:");
			console.log("  status    Show heartbeat state");
			console.log("  trigger   Force an immediate heartbeat tick");
	}
}
