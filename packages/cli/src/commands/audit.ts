import type { CliContext } from "../cli.js";

export async function auditCommand(args: string[], _ctx: CliContext): Promise<void> {
	const { runAudit, formatAuditReport } = await import("@randal/credentials");

	const jsonFlag = args.includes("--json");

	const report = await runAudit();

	if (jsonFlag) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatAuditReport(report));
	}
}
