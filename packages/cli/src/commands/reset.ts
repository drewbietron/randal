import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cancel, confirm, intro, isCancel, log, note, outro, spinner } from "@clack/prompts";

export async function resetCommand(args: string[]): Promise<void> {
	const hasAll = args.includes("--all");
	const hasYes = args.includes("--yes");

	intro("Randal Reset");

	// Gather what exists
	const configPath = resolve("randal.config.yaml");
	const envPath = resolve(".env");
	const randalDir = join(homedir(), ".randal");
	const jobsDir = join(randalDir, "jobs");
	const cronFile = join(randalDir, "cron.yaml");
	const meiliDataDir = join(randalDir, "meili-data");

	const hasConfig = existsSync(configPath);
	const hasEnv = existsSync(envPath);
	const hasJobs = existsSync(jobsDir) && readdirSync(jobsDir).length > 0;
	const hasCron = existsSync(cronFile);
	const hasMeiliData = existsSync(meiliDataDir);

	// Check if there's anything to reset
	if (!hasConfig && !hasJobs && !hasCron && !(hasAll && (hasEnv || hasMeiliData))) {
		log.info("Nothing to reset. Already clean.");
		outro("Run randal init to set up.");
		return;
	}

	// Show what will be removed
	const willRemove: string[] = [];
	if (hasConfig) willRemove.push("randal.config.yaml");
	if (hasJobs) {
		const count = readdirSync(jobsDir).filter((f) => f.endsWith(".yaml")).length;
		willRemove.push(`~/.randal/jobs/ (${count} job files)`);
	}
	if (hasCron) willRemove.push("~/.randal/cron.yaml");
	if (hasAll && hasEnv) willRemove.push(".env");
	if (hasAll && hasMeiliData) willRemove.push("~/.randal/meili-data/");
	if (hasAll) willRemove.push("randal-meilisearch Docker container (if running)");

	note(willRemove.join("\n"), "Will remove:");

	// Confirm
	if (!hasYes) {
		const ok = await confirm({ message: "Proceed with reset?", initialValue: false });
		if (isCancel(ok) || !ok) {
			cancel("Reset cancelled. Nothing was changed.");
			return;
		}
	}

	const s = spinner();
	s.start("Resetting...");

	const removed: string[] = [];

	// Delete config
	if (hasConfig) {
		unlinkSync(configPath);
		removed.push("randal.config.yaml");
	}

	// Clear jobs
	if (hasJobs) {
		rmSync(jobsDir, { recursive: true, force: true });
		removed.push("~/.randal/jobs/");
	}

	// Clear cron state
	if (hasCron) {
		unlinkSync(cronFile);
		removed.push("~/.randal/cron.yaml");
	}

	if (hasAll) {
		// Delete .env (extra confirmation unless --yes)
		if (hasEnv) {
			if (hasYes) {
				unlinkSync(envPath);
				removed.push(".env");
			} else {
				s.stop("Pausing for confirmation...");
				const okEnv = await confirm({
					message: ".env contains your API keys. Really delete it?",
					initialValue: false,
				});
				if (!isCancel(okEnv) && okEnv) {
					unlinkSync(envPath);
					removed.push(".env");
				} else {
					removed.push(".env (kept)");
				}
				s.start("Continuing reset...");
			}
		}

		// Stop Meilisearch Docker container
		try {
			const proc = Bun.spawnSync(["docker", "rm", "-f", "randal-meilisearch"]);
			if (proc.exitCode === 0) {
				removed.push("randal-meilisearch container (stopped)");
			}
		} catch {
			// Docker not available or container doesn't exist
		}

		// Clear Meilisearch data
		if (hasMeiliData) {
			rmSync(meiliDataDir, { recursive: true, force: true });
			removed.push("~/.randal/meili-data/");
		}
	}

	s.stop("Reset complete");

	note(removed.join("\n"), "Removed:");
	outro("Run randal init to start fresh.");
}
