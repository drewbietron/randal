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

export function isContainer(): boolean {
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

/** Resolve the root directory of the Randal repository. */
function getRootDir(): string {
	return resolve(import.meta.dir, "../../../../..");
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
 * For channel="main": fetches origin/main and compares commit hashes.
 * For channel="stable": fetches tags and compares semver versions.
 */
export async function checkForUpdate(channel = "stable"): Promise<UpdateCheckResult> {
	const { RANDAL_VERSION } = await import("@randal/core");

	const rootDir = getRootDir();

	// Fetch latest tags (always, for version detection)
	await runGit(["fetch", "--tags", "origin"], rootDir);

	if (channel === "main") {
		// Fetch the main branch
		await runGit(["fetch", "origin", "main"], rootDir);

		const { stdout: localHash } = await runGit(["rev-parse", "HEAD"], rootDir);
		const { stdout: remoteHash } = await runGit(["rev-parse", "origin/main"], rootDir);
		const { stdout: remoteShort } = await runGit(["rev-parse", "--short", "origin/main"], rootDir);

		return {
			available: localHash !== remoteHash,
			current: RANDAL_VERSION,
			latest: remoteShort || RANDAL_VERSION,
			channel,
		};
	}

	// channel="stable": use latest semver tag
	const { stdout } = await runGit(["tag", "--sort=-version:refname", "-l", "v*"], rootDir);
	const tags = stdout.split("\n").filter((t) => t.startsWith("v"));
	const latest = tags[0]?.replace(/^v/, "") || RANDAL_VERSION;

	return {
		available: compareVersions(RANDAL_VERSION, latest) < 0,
		current: RANDAL_VERSION,
		latest,
		channel,
	};
}

// ---- Apply update (reusable) ----

export interface ApplyUpdateResult {
	applied: boolean;
	fromVersion: string;
	toVersion: string;
}

/**
 * Apply an update to the Randal installation.
 * Throws on failure — callers decide how to handle errors.
 *
 * For channel="main": `git pull --ff-only origin main`
 * For channel="stable" or when pin is specified: `git checkout <tag>`
 * After code update: runs `bun install`, `just build-tools`, and optionally `agent/setup.sh`.
 */
export async function applyUpdate(options?: {
	channel?: string;
	pin?: string;
	runSetup?: boolean;
}): Promise<ApplyUpdateResult> {
	const { RANDAL_VERSION } = await import("@randal/core");
	const rootDir = getRootDir();
	const channel = options?.channel ?? "stable";
	const pin = options?.pin;

	// Container check — no-op, not an error
	if (isContainer()) {
		return { applied: false, fromVersion: RANDAL_VERSION, toVersion: RANDAL_VERSION };
	}

	// Verify git repo
	if (!existsSync(resolve(rootDir, ".git"))) {
		throw new Error("Not a git-based install. Cannot auto-update.");
	}

	// Fetch
	await runGit(["fetch", "--tags", "origin"], rootDir);

	let toVersion: string;

	if (channel === "main" && !pin) {
		// ---- Branch mode: git pull --ff-only origin main ----
		await runGit(["fetch", "origin", "main"], rootDir);

		const { stdout: localHash } = await runGit(["rev-parse", "HEAD"], rootDir);
		const { stdout: remoteHash } = await runGit(["rev-parse", "origin/main"], rootDir);

		if (localHash === remoteHash) {
			return { applied: false, fromVersion: RANDAL_VERSION, toVersion: RANDAL_VERSION };
		}

		// Check dirty tree
		const { stdout: status } = await runGit(["status", "--porcelain"], rootDir);
		if (status) {
			throw new Error("Working tree has uncommitted changes. Commit or stash first.");
		}

		// Pull with --ff-only (safe: fails if history diverged)
		const { exitCode: pullExit, stdout: pullStdout } = await runGit(
			["pull", "--ff-only", "origin", "main"],
			rootDir,
		);
		if (pullExit !== 0) {
			throw new Error(
				`git pull --ff-only failed (exit ${pullExit}). History may have diverged.\n${pullStdout}`,
			);
		}

		const { stdout: newShort } = await runGit(["rev-parse", "--short", "HEAD"], rootDir);
		toVersion = newShort || "unknown";
	} else {
		// ---- Tag mode: git checkout <tag> ----
		let targetTag: string;

		if (pin) {
			targetTag = pin.startsWith("v") ? pin : `v${pin}`;
			const { exitCode } = await runGit(["rev-parse", targetTag], rootDir);
			if (exitCode !== 0) {
				throw new Error(`Tag '${targetTag}' not found.`);
			}
		} else {
			const { stdout } = await runGit(["tag", "--sort=-version:refname", "-l", "v*"], rootDir);
			const tags = stdout.split("\n").filter((t) => t.startsWith("v"));
			if (tags.length === 0) {
				return { applied: false, fromVersion: RANDAL_VERSION, toVersion: RANDAL_VERSION };
			}
			targetTag = tags[0];
		}

		const targetVersion = targetTag.replace(/^v/, "");

		// Skip if already at target (unless pinned explicitly)
		if (compareVersions(RANDAL_VERSION, targetVersion) >= 0 && !pin) {
			return { applied: false, fromVersion: RANDAL_VERSION, toVersion: RANDAL_VERSION };
		}

		// Check dirty tree
		const { stdout: status } = await runGit(["status", "--porcelain"], rootDir);
		if (status) {
			throw new Error("Working tree has uncommitted changes. Commit or stash first.");
		}

		const { exitCode: checkoutExit } = await runGit(["checkout", targetTag], rootDir);
		if (checkoutExit !== 0) {
			throw new Error(`git checkout ${targetTag} failed.`);
		}

		toVersion = targetVersion;
	}

	// ---- Post-update steps (shared by both modes) ----

	// Install dependencies
	const installProc = Bun.spawn(["bun", "install"], {
		cwd: rootDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const installStdout = await new Response(installProc.stdout).text();
	const installStderr = await new Response(installProc.stderr).text();
	const installExit = await installProc.exited;
	if (installExit !== 0) {
		throw new Error(`bun install failed (exit ${installExit}):\n${installStderr || installStdout}`);
	}

	// Build tools if needed
	const toolsDir = resolve(rootDir, "tools");
	if (existsSync(toolsDir)) {
		const justProc = Bun.spawn(["just", "build-tools"], {
			cwd: rootDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const justStdout = await new Response(justProc.stdout).text();
		const justStderr = await new Response(justProc.stderr).text();
		const justExit = await justProc.exited;
		if (justExit !== 0) {
			throw new Error(`just build-tools failed (exit ${justExit}):\n${justStderr || justStdout}`);
		}
	}

	// Run agent/setup.sh if present
	const setupScript = resolve(rootDir, "agent/setup.sh");
	if (options?.runSetup !== false && existsSync(setupScript)) {
		const setupProc = Bun.spawn(["bash", setupScript, "--non-interactive"], {
			cwd: rootDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, NON_INTERACTIVE: "true" },
		});

		const setupExited = setupProc.exited;
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("agent/setup.sh timed out after 120s")), 120_000),
		);

		const setupStdout = await new Response(setupProc.stdout).text();
		const setupStderr = await new Response(setupProc.stderr).text();

		let setupExit: number;
		try {
			setupExit = await Promise.race([setupExited, timeout]);
		} catch (err) {
			// Kill the hung process on timeout
			try {
				setupProc.kill();
			} catch {
				/* ignore */
			}
			throw err;
		}

		if (setupExit !== 0) {
			throw new Error(`agent/setup.sh failed (exit ${setupExit}):\n${setupStderr || setupStdout}`);
		}
	}

	return { applied: true, fromVersion: RANDAL_VERSION, toVersion };
}

// ---- CLI command ----

export async function updateCommand(args: string[], ctx: CliContext): Promise<void> {
	const { RANDAL_VERSION } = await import("@randal/core");

	const checkOnly = args.includes("--check");
	const dryRun = args.includes("--dry-run");
	const restart = args.includes("--restart");
	const pinIdx = args.indexOf("--pin");
	const pinVersion = pinIdx !== -1 ? args[pinIdx + 1] : undefined;

	// Resolve channel: CLI flag > config > default
	const channelIdx = args.indexOf("--channel");
	const channel =
		channelIdx !== -1 ? args[channelIdx + 1] : (ctx.config?.updates?.channel ?? "stable");

	const rootDir = getRootDir();

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

	// 2. Check only?
	if (checkOnly) {
		const result = await checkForUpdate(channel);
		if (result.available) {
			console.log(`Update available: ${result.current} -> ${result.latest}`);
			process.exit(0);
		} else {
			console.log(`Already up to date (${RANDAL_VERSION}).`);
			process.exit(1);
		}
	}

	// 3. Dry run?
	if (dryRun) {
		if (!existsSync(resolve(rootDir, ".git"))) {
			console.error("Error: not a git-based install.");
			process.exit(1);
		}
		await runGit(["fetch", "--tags", "origin"], rootDir);
		if (channel === "main") {
			await runGit(["fetch", "origin", "main"], rootDir);
			const { stdout } = await runGit(["log", "--oneline", "HEAD..origin/main"], rootDir);
			console.log("\nCommits that would be applied:");
			console.log(stdout || "  (none)");
		} else {
			const { stdout: tagList } = await runGit(
				["tag", "--sort=-version:refname", "-l", "v*"],
				rootDir,
			);
			const tags = tagList.split("\n").filter((t) => t.startsWith("v"));
			const targetTag = pinVersion
				? pinVersion.startsWith("v")
					? pinVersion
					: `v${pinVersion}`
				: tags[0];
			if (targetTag) {
				const { stdout } = await runGit(["log", "--oneline", `HEAD..${targetTag}`], rootDir);
				console.log("\nCommits that would be applied:");
				console.log(stdout || "  (none)");
			}
		}
		return;
	}

	// 4. Apply update
	console.log(`Checking for updates (channel: ${channel})...`);
	try {
		const result = await applyUpdate({ channel, pin: pinVersion });

		if (!result.applied) {
			console.log(`Already up to date (${RANDAL_VERSION}).`);
			return;
		}

		console.log(`\nUpdated: ${result.fromVersion} -> ${result.toVersion}`);

		// 5. Restart gateway if requested
		if (restart) {
			const { readPid } = await import("./gateway.js");
			const pid = readPid();
			if (pid) {
				try {
					process.kill(pid, "SIGHUP");
					console.log(`Sent SIGHUP to gateway (PID ${pid}) for graceful restart.`);
				} catch (err) {
					console.warn(
						`Failed to send SIGHUP to gateway (PID ${pid}): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			} else {
				console.log("No running gateway found. Start one with 'randal serve'.");
			}
		} else {
			console.log("If running as a daemon, restart with: randal serve");
		}
	} catch (err) {
		console.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
