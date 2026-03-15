import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CliContext } from "../cli.js";

// ---- Helpers ----

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { stdout: stdout.trim(), exitCode };
}

function isContainer(): boolean {
	return existsSync("/.dockerenv") || process.env.RANDAL_CONTAINER === "true";
}

function compareVersions(current: string, latest: string): number {
	const parse = (v: string) =>
		v
			.replace(/^v/, "")
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);

	const a = parse(current);
	const b = parse(latest);

	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

// ---- Update check (reusable) ----

export interface UpdateCheckResult {
	available: boolean;
	current: string;
	latest: string;
	channel: string;
}

/**
 * Check if an update is available.
 * Works from git-based installs by fetching tags.
 */
export async function checkForUpdate(channel = "stable"): Promise<UpdateCheckResult> {
	const { RANDAL_VERSION } = await import("@randal/core");

	const rootDir = resolve(import.meta.dir, "../../../../..");

	// Fetch latest tags
	await runGit(["fetch", "--tags", "origin"], rootDir);

	let latest: string;

	if (channel === "latest") {
		// Use HEAD of main branch
		const { stdout } = await runGit(["rev-parse", "--short", "origin/main"], rootDir);
		latest = stdout || RANDAL_VERSION;
	} else {
		// Use latest semver tag
		const { stdout } = await runGit(["tag", "--sort=-version:refname", "-l", "v*"], rootDir);
		const tags = stdout.split("\n").filter((t) => t.startsWith("v"));
		latest = tags[0]?.replace(/^v/, "") || RANDAL_VERSION;
	}

	return {
		available: compareVersions(RANDAL_VERSION, latest) < 0,
		current: RANDAL_VERSION,
		latest,
		channel,
	};
}

// ---- CLI command ----

export async function updateCommand(args: string[], _ctx: CliContext): Promise<void> {
	const { RANDAL_VERSION } = await import("@randal/core");

	const checkOnly = args.includes("--check");
	const dryRun = args.includes("--dry-run");
	const pinIdx = args.indexOf("--pin");
	const pinVersion = pinIdx !== -1 ? args[pinIdx + 1] : undefined;

	const rootDir = resolve(import.meta.dir, "../../../../..");

	// 1. Detect environment
	if (isContainer()) {
		console.log(`Current version: ${RANDAL_VERSION}`);

		try {
			const result = await checkForUpdate("stable");
			if (result.available) {
				console.log(`Update available: ${result.current} -> ${result.latest}`);
				console.log("Container mode: rebuild your container image to update.");
			} else {
				console.log("Already up to date.");
			}
		} catch {
			console.log("Cannot check for updates in container mode without git.");
		}
		return;
	}

	// Check if git repo
	if (!existsSync(resolve(rootDir, ".git"))) {
		console.error("Error: not a git-based install. Cannot auto-update.");
		process.exit(1);
	}

	// 2. Fetch tags
	console.log("Fetching latest tags...");
	await runGit(["fetch", "--tags", "origin"], rootDir);

	// 3. Determine target version
	let targetTag: string;

	if (pinVersion) {
		targetTag = pinVersion.startsWith("v") ? pinVersion : `v${pinVersion}`;
		// Verify tag exists
		const { exitCode } = await runGit(["rev-parse", targetTag], rootDir);
		if (exitCode !== 0) {
			console.error(`Error: tag '${targetTag}' not found.`);
			process.exit(1);
		}
	} else {
		const { stdout } = await runGit(["tag", "--sort=-version:refname", "-l", "v*"], rootDir);
		const tags = stdout.split("\n").filter((t) => t.startsWith("v"));
		if (tags.length === 0) {
			console.log("No release tags found. Already at latest.");
			return;
		}
		targetTag = tags[0];
	}

	const targetVersion = targetTag.replace(/^v/, "");

	// 4. Compare versions
	if (compareVersions(RANDAL_VERSION, targetVersion) >= 0 && !pinVersion) {
		console.log(`Already up to date (${RANDAL_VERSION}).`);
		return;
	}

	console.log(`Update available: ${RANDAL_VERSION} -> ${targetVersion}`);

	// 5. Check only?
	if (checkOnly) {
		process.exit(compareVersions(RANDAL_VERSION, targetVersion) < 0 ? 0 : 1);
	}

	// 6. Dry run?
	if (dryRun) {
		const { stdout } = await runGit(["log", "--oneline", `HEAD..${targetTag}`], rootDir);
		console.log("\nCommits that would be applied:");
		console.log(stdout || "  (none)");
		return;
	}

	// 7. Check for dirty working tree
	const { stdout: status } = await runGit(["status", "--porcelain"], rootDir);
	if (status) {
		console.error("Error: working tree has uncommitted changes. Commit or stash first.");
		process.exit(1);
	}

	// 8. Apply update
	console.log(`Checking out ${targetTag}...`);
	const { exitCode: checkoutExit } = await runGit(["checkout", targetTag], rootDir);
	if (checkoutExit !== 0) {
		console.error("Error: git checkout failed.");
		process.exit(1);
	}

	// 9. Install dependencies
	console.log("Installing dependencies...");
	const installProc = Bun.spawn(["bun", "install"], {
		cwd: rootDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	await installProc.exited;

	// 10. Build tools if needed
	const toolsDir = resolve(rootDir, "tools");
	if (existsSync(toolsDir)) {
		console.log("Rebuilding tools...");
		const justProc = Bun.spawn(["just", "build-tools"], {
			cwd: rootDir,
			stdout: "inherit",
			stderr: "inherit",
		});
		await justProc.exited;
	}

	console.log(`\nUpdated to ${targetVersion} successfully.`);
	console.log("If running as a daemon, restart with: randal serve");
}
