import type { CliContext } from "../cli.js";

export async function contextCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";

	// First non-flag arg might be job-id, rest is text
	const nonFlags = args.filter((a) => !a.startsWith("-"));
	let jobId: string | undefined;
	let text: string;

	if (nonFlags.length >= 2) {
		jobId = nonFlags[0];
		text = nonFlags.slice(1).join(" ");
	} else if (nonFlags.length === 1) {
		text = nonFlags[0];
	} else {
		console.error("Usage: randal context [job-id] <text>");
		process.exit(1);
		return;
	}

	// If no jobId, try to get the current running job
	if (!jobId) {
		try {
			const res = await fetch(`${url}/jobs?status=running`, {
				headers: { Authorization: `Bearer ${authToken}` },
			});
			const jobs = (await res.json()) as { id: string }[];
			if (jobs.length === 1) {
				jobId = jobs[0].id;
			} else if (jobs.length === 0) {
				console.error("No running jobs");
				process.exit(1);
			} else {
				console.error("Multiple running jobs. Specify a job ID.");
				process.exit(1);
			}
		} catch (err) {
			console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	}

	try {
		const res = await fetch(`${url}/job/${jobId}/context`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authToken}`,
			},
			body: JSON.stringify({ text }),
		});

		if (!res.ok) {
			console.error(`Error: ${res.status} ${res.statusText}`);
			process.exit(1);
		}

		console.log(`Context injected into job ${jobId}`);
	} catch (err) {
		console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
