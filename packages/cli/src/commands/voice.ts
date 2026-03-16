import type { CliContext } from "../cli.js";

export async function voiceCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const sub = args[0];

	if (!sub || sub === "--help") {
		console.log(`
Usage:
  randal voice status     Show active voice sessions
`);
		return;
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${authToken}`,
		"Content-Type": "application/json",
	};

	switch (sub) {
		case "status": {
			try {
				const res = await fetch(`${url}/voice/status`, { headers });
				if (!res.ok) {
					console.error(`Error: ${res.status} ${res.statusText}`);
					process.exit(1);
				}

				const data = (await res.json()) as {
					enabled: boolean;
					sessions: Array<{
						id: string;
						callId: string;
						status: string;
						duration: number;
						transcriptLength: number;
						startedAt: string;
					}>;
				};

				if (!data.enabled) {
					console.log("Voice channel is not enabled.");
					return;
				}

				if (!data.sessions || data.sessions.length === 0) {
					console.log("No active voice sessions.");
					return;
				}

				console.log("Session ID | Call ID        | Status  | Duration | Transcript Len | Started");
				console.log("-".repeat(85));
				for (const s of data.sessions) {
					const duration = formatDuration(s.duration);
					console.log(
						`${s.id.slice(0, 10).padEnd(10)} | ${s.callId.slice(0, 14).padEnd(14)} | ${s.status.padEnd(7)} | ${duration.padStart(8)} | ${String(s.transcriptLength).padStart(14)} | ${s.startedAt}`,
					);
				}

				console.log("");
				console.log(`Total active sessions: ${data.sessions.length}`);
			} catch (err) {
				console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
				process.exit(1);
			}
			break;
		}

		default:
			console.error(`Unknown voice subcommand: ${sub}`);
			console.log("Usage: randal voice <status>");
			process.exit(1);
	}
}

function formatDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}m ${s}s`;
}
