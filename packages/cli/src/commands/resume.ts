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
			iterations: { current: number; history: { number: number; summary: string }[] };
			plan?: { task: string; status: string }[];
			progressHistory?: string[];
		};

		// Build resume context
		const priorContext = oldJob.iterations.history
			.map((h) => `Iteration ${h.number}: ${h.summary}`)
			.join("\n");

		let resumePrompt = `${oldJob.prompt}\n\n## Prior Run Context\nThis is a resumed job. Previous run reached iteration ${oldJob.iterations.current}.\n${priorContext}`;

		// Include plan state if present
		if (oldJob.plan && oldJob.plan.length > 0) {
			const planLines = oldJob.plan
				.map((t) => {
					const icon =
						t.status === "completed"
							? "[x]"
							: t.status === "in_progress"
								? "[>]"
								: t.status === "failed"
									? "[!]"
									: "[ ]";
					return `- ${icon} ${t.task} (${t.status})`;
				})
				.join("\n");
			resumePrompt += `\n\n## Task Plan (from previous run)\n${planLines}`;
		}

		// Include progress history if present
		if (oldJob.progressHistory && oldJob.progressHistory.length > 0) {
			resumePrompt += `\n\n## Previous Progress\n${oldJob.progressHistory.join("\n\n")}`;
		}

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
