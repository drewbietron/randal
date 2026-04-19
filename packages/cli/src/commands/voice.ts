import type { CliContext } from "../cli.js";

export async function voiceCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const sub = args[0];

	if (!sub || sub === "--help") {
		console.log(`
Usage:
  randal voice status     Show active voice sessions
  randal voice call <to>  Start an outbound voice call
`);
		return;
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${authToken}`,
		"Content-Type": "application/json",
	};

	switch (sub) {
		case "call": {
			const to = args[1];
			if (!to || to === "--help" || to === "-h") {
				console.error("Usage: randal voice call <to> [--reason text] [--script text]");
				if (!to || to === "--help" || to === "-h") {
					return;
				}
				process.exit(1);
			}

			const reasonFlag = args.indexOf("--reason");
			const scriptFlag = args.indexOf("--script");
			const reason = reasonFlag !== -1 ? args[reasonFlag + 1] : undefined;
			const script = scriptFlag !== -1 ? args[scriptFlag + 1] : undefined;

			try {
				const res = await fetch(`${url}/voice/call`, {
					method: "POST",
					headers,
					body: JSON.stringify({ to, reason, script }),
				});
				const data = (await res.json()) as
					| {
							sessionId: string;
							callSid?: string;
							roomName: string;
							status: string;
							phoneNumber?: string;
					  }
					| { error: string; code?: string; reason?: string; missing?: string[] };

				if (!res.ok) {
					console.error(`Voice call failed: ${data.error}`);
					if ("reason" in data && data.reason) {
						console.error(`Reason: ${data.reason}`);
					}
					if ("missing" in data && data.missing && data.missing.length > 0) {
						console.error(`Missing config: ${data.missing.join(", ")}`);
					}
					process.exit(1);
				}

				console.log(`Voice call queued: ${data.sessionId}`);
				if (data.callSid) {
					console.log(`Twilio Call SID: ${data.callSid}`);
				}
				console.log(`Room: ${data.roomName}`);
				console.log(`Status: ${data.status}`);
			} catch (err) {
				console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
				process.exit(1);
			}
			break;
		}

		case "status": {
			try {
				const res = await fetch(`${url}/voice/status`, { headers });
				const data = (await res.json()) as
					| {
							available: true;
							enabled: boolean;
							reason: string;
							missing: string[];
							sessions: Array<{
								id: string;
								callId: string;
								status: string;
								duration: number;
								transcriptLength: number;
								startedAt: string;
							}>;
					  }
					| {
							available: false;
							enabled: boolean;
							error: string;
							code: string;
							reason: string;
							missing: string[];
							sessions: [];
					  };

				if (!res.ok && data.available !== false) {
					console.error(`Error: ${res.status} ${res.statusText}`);
					process.exit(1);
				}

				if (!data.available) {
					console.log(`Voice unavailable: ${data.reason}.`);
					if (data.missing.length > 0) {
						console.log(`Missing config: ${data.missing.join(", ")}`);
					}
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
			console.log("Usage: randal voice <status|call>");
			process.exit(1);
	}
}

function formatDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}m ${s}s`;
}
