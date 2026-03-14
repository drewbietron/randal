import type { CliContext } from "../cli.js";

export async function stopCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const jobId = args.find((a) => !a.startsWith("-"));

	if (!jobId) {
		console.error("Usage: randal stop <job-id>");
		process.exit(1);
	}

	try {
		const res = await fetch(`${url}/job/${jobId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${authToken}` },
		});

		if (!res.ok) {
			console.error(`Error: ${res.status} ${res.statusText}`);
			process.exit(1);
		}

		const data = (await res.json()) as { id: string; status: string };
		console.log(`Job ${data.id}: ${data.status}`);
	} catch (err) {
		console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
