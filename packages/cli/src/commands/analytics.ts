import type { CliContext } from "../cli.js";

export async function analyticsCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const sub = args[0];

	if (!sub || sub === "--help") {
		console.log(`
Usage:
  randal analytics scores              Show reliability scores
  randal analytics recommendations     Show current recommendations
`);
		return;
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${authToken}`,
		"Content-Type": "application/json",
	};

	switch (sub) {
		case "scores": {
			try {
				const res = await fetch(`${url}/analytics/scores`, { headers });
				if (!res.ok) {
					console.error(`Error: ${res.status} ${res.statusText}`);
					process.exit(1);
				}

				const data = (await res.json()) as {
					status?: string;
					overall?: number;
					byAgent?: Record<string, number>;
					byModel?: Record<string, number>;
					byDomain?: Record<string, number>;
				};

				if (data.status === "insufficient_data") {
					console.log("Insufficient data to compute reliability scores.");
					console.log("Complete more jobs to generate analytics.");
					return;
				}

				if (data.overall !== undefined) {
					console.log(`Overall Reliability: ${(data.overall * 100).toFixed(1)}%`);
					console.log("");
				}

				if (data.byAgent && Object.keys(data.byAgent).length > 0) {
					console.log("By Agent:");
					console.log("-".repeat(40));
					for (const [agent, score] of Object.entries(data.byAgent)) {
						const bar = makeBar(score);
						console.log(`  ${agent.padEnd(20)} ${bar} ${(score * 100).toFixed(1)}%`);
					}
					console.log("");
				}

				if (data.byModel && Object.keys(data.byModel).length > 0) {
					console.log("By Model:");
					console.log("-".repeat(40));
					for (const [model, score] of Object.entries(data.byModel)) {
						const bar = makeBar(score);
						console.log(`  ${model.padEnd(20)} ${bar} ${(score * 100).toFixed(1)}%`);
					}
					console.log("");
				}

				if (data.byDomain && Object.keys(data.byDomain).length > 0) {
					console.log("By Domain:");
					console.log("-".repeat(40));
					for (const [domain, score] of Object.entries(data.byDomain)) {
						const bar = makeBar(score);
						console.log(`  ${domain.padEnd(20)} ${bar} ${(score * 100).toFixed(1)}%`);
					}
				}
			} catch (err) {
				console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
				process.exit(1);
			}
			break;
		}

		case "recommendations": {
			try {
				const res = await fetch(`${url}/analytics/recommendations`, { headers });
				if (!res.ok) {
					console.error(`Error: ${res.status} ${res.statusText}`);
					process.exit(1);
				}

				const data = (await res.json()) as {
					recommendations: Array<{
						severity: "info" | "warning" | "critical";
						message: string;
						action?: string;
					}>;
				};

				if (!data.recommendations || data.recommendations.length === 0) {
					console.log("No recommendations at this time.");
					return;
				}

				console.log("Recommendations:");
				console.log("-".repeat(60));
				for (const rec of data.recommendations) {
					const icon =
						rec.severity === "critical"
							? "\x1b[31m[CRITICAL]\x1b[0m"
							: rec.severity === "warning"
								? "\x1b[33m[WARNING]\x1b[0m"
								: "\x1b[36m[INFO]\x1b[0m";
					console.log(`  ${icon} ${rec.message}`);
					if (rec.action) {
						console.log(`         Action: ${rec.action}`);
					}
				}
			} catch (err) {
				console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
				process.exit(1);
			}
			break;
		}

		default:
			console.error(`Unknown analytics subcommand: ${sub}`);
			console.log("Usage: randal analytics <scores|recommendations>");
			process.exit(1);
	}
}

function makeBar(ratio: number): string {
	const width = 20;
	const filled = Math.round(ratio * width);
	return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}
