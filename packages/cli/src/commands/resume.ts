import type { CliContext } from "../cli.js";

export async function resumeCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const jobId = args.find((a) => !a.startsWith("-"));

	if (!jobId) {
		console.error("Usage: randal resume <job-id>");
		process.exit(1);
	}

	try {
		// Get the failed job details
		const getRes = await fetch(`${url}/job/${jobId}`, {
			headers: { Authorization: `Bearer ${authToken}` },
		});

		if (!getRes.ok) {
			console.error(`Error getting job: ${getRes.status}`);
			process.exit(1);
		}

		const oldJob = (await getRes.json()) as {
			prompt: string;
			agent: string;
			model: string;
			maxIterations: number;
			workdir: string;
			iterations: { current: number; history: { summary: string }[] };
		};

		// Build resume context
		const priorContext = oldJob.iterations.history
			.map((h: { summary: string }, i: number) => `Iteration ${i + 1}: ${h.summary}`)
			.join("\n");

		const resumePrompt = `${oldJob.prompt}\n\n## Prior Run Context\nThis is a resumed job. Previous run reached iteration ${oldJob.iterations.current}.\n${priorContext}`;

		// Submit new job
		const res = await fetch(`${url}/job`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authToken}`,
			},
			body: JSON.stringify({
				prompt: resumePrompt,
				agent: oldJob.agent,
				model: oldJob.model,
				maxIterations: oldJob.maxIterations,
				workdir: oldJob.workdir,
			}),
		});

		if (!res.ok) {
			console.error(`Error creating resume job: ${res.status}`);
			process.exit(1);
		}

		const data = (await res.json()) as { id: string; status: string };
		console.log(`Resumed as job ${data.id} (${data.status})`);
	} catch (err) {
		console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
