import type { Job } from "@randal/core";
import type { CliContext } from "../cli.js";

export async function jobsCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";

	let status: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--status") status = args[++i];
	}

	try {
		const endpoint = status ? `${url}/jobs?status=${status}` : `${url}/jobs`;
		const res = await fetch(endpoint, {
			headers: { Authorization: `Bearer ${authToken}` },
		});

		if (!res.ok) {
			console.error(`Error: ${res.status} ${res.statusText}`);
			process.exit(1);
		}

		const jobs = (await res.json()) as Job[];
		if (jobs.length === 0) {
			console.log("No jobs found");
			return;
		}

		console.log("ID       | Status   | Iter | Agent      | Prompt");
		console.log("-".repeat(70));
		for (const job of jobs) {
			const promptPreview = job.prompt.slice(0, 30).replace(/\n/g, " ");
			console.log(
				`${job.id} | ${job.status.padEnd(8)} | ${String(job.iterations.current).padStart(2)}/${String(job.maxIterations).padEnd(2)} | ${job.agent.padEnd(10)} | ${promptPreview}`,
			);
		}
	} catch (err) {
		console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
