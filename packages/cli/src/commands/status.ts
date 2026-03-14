import type { Job } from "@randal/core";
import type { CliContext } from "../cli.js";

export async function statusCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const jobId = args.find((a) => !a.startsWith("-"));

	try {
		const endpoint = jobId ? `${url}/job/${jobId}` : `${url}/jobs?status=running`;
		const res = await fetch(endpoint, {
			headers: { Authorization: `Bearer ${authToken}` },
		});

		if (!res.ok) {
			console.error(`Error: ${res.status} ${res.statusText}`);
			process.exit(1);
		}

		const data = await res.json();

		if (jobId) {
			const job = data as Job;
			console.log(`Job: ${job.id}`);
			console.log(`Status: ${job.status}`);
			console.log(`Agent: ${job.agent}`);
			console.log(`Iteration: ${job.iterations.current}/${job.maxIterations}`);
			if (job.error) console.log(`Error: ${job.error}`);
			if (job.duration) console.log(`Duration: ${job.duration}s`);
		} else {
			const jobs = data as Job[];
			if (jobs.length === 0) {
				console.log("No running jobs");
			} else {
				for (const job of jobs) {
					console.log(
						`${job.id} | ${job.status} | iter ${job.iterations.current}/${job.maxIterations} | ${job.agent}`,
					);
				}
			}
		}
	} catch (err) {
		console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
