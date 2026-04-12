import type { CliContext } from "../cli.js";

export async function meshCommand(args: string[], ctx: CliContext): Promise<void> {
	const url = ctx.url ?? "http://localhost:7600";
	const authToken = process.env.RANDAL_API_TOKEN ?? "";
	const sub = args[0];

	if (!sub || sub === "--help") {
		console.log(`
Usage:
  randal mesh status                Show all instances in the mesh
  randal mesh route <prompt>        Dry-run the routing algorithm
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
				const res = await fetch(`${url}/mesh/status`, { headers });
				if (!res.ok) {
					console.error(`Error: ${res.status} ${res.statusText}`);
					process.exit(1);
				}

				const data = (await res.json()) as {
					instances: Array<{
						id: string;
						name: string;
						status: string;
						health: string;
						load: number;
						role: string;
						expertise: string;
						specialization: string;
						lastSeen: string;
					}>;
				};

				if (!data.instances || data.instances.length === 0) {
					console.log("No mesh instances found");
					return;
				}

				console.log(
					"ID        | Name           | Status  | Health  | Load | Role                      | Expertise",
				);
				console.log("-".repeat(110));
				for (const inst of data.instances) {
					const loadPct = `${Math.round(inst.load * 100)}%`;
					const role = inst.role || inst.specialization || "-";
					const expertise = inst.expertise
						? inst.expertise.length > 25
							? `${inst.expertise.slice(0, 25)}...`
							: inst.expertise
						: "-";
					console.log(
						`${inst.id.slice(0, 8).padEnd(9)} | ${inst.name.padEnd(14)} | ${inst.status.padEnd(7)} | ${inst.health.padEnd(7)} | ${loadPct.padStart(4)} | ${role.padEnd(25)} | ${expertise}`,
					);
				}
			} catch (err) {
				console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
				process.exit(1);
			}
			break;
		}

		case "route": {
			const prompt = args.slice(1).join(" ");
			if (!prompt) {
				console.error("Usage: randal mesh route <prompt>");
				process.exit(1);
			}

			try {
				const res = await fetch(`${url}/mesh/route`, {
					method: "POST",
					headers,
					body: JSON.stringify({ prompt, dryRun: true }),
				});

				if (!res.ok) {
					console.error(`Error: ${res.status} ${res.statusText}`);
					process.exit(1);
				}

				const data = (await res.json()) as {
					selectedInstance: {
						id: string;
						name: string;
						score: number;
					};
					scores: Array<{
						instanceId: string;
						name: string;
						score: number;
						breakdown: {
							expertiseScore: number;
							specializationScore: number;
							reliabilityScore: number;
							loadScore: number;
							modelMatchScore: number;
						};
					}>;
				};

				console.log(
					`Selected: ${data.selectedInstance.name} (score: ${data.selectedInstance.score.toFixed(3)})`,
				);
				console.log("");
				console.log("Score Breakdown:");
				console.log("Instance       | Total  | Expert | Spec   | Reliab | Load   | Model");
				console.log("-".repeat(85));
				for (const s of data.scores) {
					const b = s.breakdown;
					console.log(
						`${s.name.padEnd(14)} | ${s.score.toFixed(3).padStart(6)} | ${(b.expertiseScore?.toFixed(3) ?? "  N/A").padStart(6)} | ${(b.specializationScore?.toFixed(3) ?? "  N/A").padStart(6)} | ${(b.reliabilityScore?.toFixed(3) ?? "  N/A").padStart(6)} | ${(b.loadScore?.toFixed(3) ?? "  N/A").padStart(6)} | ${(b.modelMatchScore?.toFixed(3) ?? "  N/A").padStart(6)}`,
					);
				}
			} catch (err) {
				console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
				process.exit(1);
			}
			break;
		}

		default:
			console.error(`Unknown mesh subcommand: ${sub}`);
			console.log("Usage: randal mesh <status|route>");
			process.exit(1);
	}
}
