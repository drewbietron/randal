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

export async function cronCommand(args: string[], ctx: CliContext): Promise<void> {
	const subcommand = args[0];
	const url = getUrl(ctx);
	const headers = authHeaders(ctx);

	switch (subcommand) {
		case "list": {
			const res = await fetch(`${url}/cron`, { headers });
			if (!res.ok) {
				console.error(`Error: ${res.status} ${res.statusText}`);
				return;
			}
			const jobs = (await res.json()) as Array<{
				name: string;
				status: string;
				lastRun: string | null;
				nextRun: string | null;
				runCount: number;
				config: { schedule: unknown; execution: string };
			}>;

			if (jobs.length === 0) {
				console.log("No cron jobs registered.");
				return;
			}

			console.log("Cron Jobs:");
			console.log("-".repeat(70));
			for (const job of jobs) {
				const schedule =
					typeof job.config.schedule === "string"
						? job.config.schedule
						: JSON.stringify(job.config.schedule);
				console.log(`  ${job.name}`);
				console.log(`    Schedule:  ${schedule}`);
				console.log(`    Execution: ${job.config.execution}`);
				console.log(`    Status:    ${job.status}`);
				console.log(`    Last Run:  ${job.lastRun ?? "never"}`);
				console.log(`    Run Count: ${job.runCount}`);
				console.log("");
			}
			break;
		}

		case "add": {
			// Parse --name, --schedule, --prompt, --isolated, --model
			const nameIdx = args.indexOf("--name");
			const scheduleIdx = args.indexOf("--schedule");
			const promptIdx = args.indexOf("--prompt");
			const modelIdx = args.indexOf("--model");
			const isIsolated = args.includes("--isolated");

			const name = nameIdx !== -1 ? args[nameIdx + 1] : args[1];
			const schedule = scheduleIdx !== -1 ? args[scheduleIdx + 1] : undefined;
			const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined;
			const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

			if (!name || !schedule || !prompt) {
				console.log(
					"Usage: randal cron add <name> --schedule <schedule> --prompt <prompt> [--isolated] [--model <model>]",
				);
				return;
			}

			// Parse schedule: try cron expression first, then { every: ... } or { at: ... }
			let parsedSchedule: string | { every: string } | { at: string } = schedule;
			if (schedule.match(/^\d+[mhds]/)) {
				parsedSchedule = { every: schedule };
			} else if (schedule.match(/^\d{4}-/)) {
				parsedSchedule = { at: schedule };
			}

			const res = await fetch(`${url}/cron`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					name,
					schedule: parsedSchedule,
					prompt,
					execution: isIsolated ? "isolated" : "main",
					model,
					announce: false,
				}),
			});

			if (!res.ok) {
				const err = await res.json();
				console.error(`Error: ${(err as { error?: string }).error ?? res.statusText}`);
				return;
			}

			console.log(`Cron job "${name}" added.`);
			break;
		}

		case "remove": {
			const name = args[1];
			if (!name) {
				console.log("Usage: randal cron remove <name>");
				return;
			}

			const res = await fetch(`${url}/cron/${encodeURIComponent(name)}`, {
				method: "DELETE",
				headers,
			});

			if (!res.ok) {
				const err = await res.json();
				console.error(`Error: ${(err as { error?: string }).error ?? res.statusText}`);
				return;
			}

			console.log(`Cron job "${name}" removed.`);
			break;
		}

		default:
			console.log("Usage: randal cron <list|add|remove>");
			console.log("");
			console.log("Commands:");
			console.log("  list                          List all cron jobs");
			console.log("  add <name> --schedule <s>     Add a cron job (--prompt, --isolated, --model)");
			console.log("  remove <name>                 Remove a cron job");
	}
}
