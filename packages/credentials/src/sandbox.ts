import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RandalConfig } from "@randal/core";
import type { ResolvedServices } from "./service-resolver.js";

// ---- Types ----

type SandboxConfig = NonNullable<RandalConfig["sandbox"]>;

export interface SandboxResult {
	/** The final env vars after sandbox transformations */
	env: Record<string, string>;
	/** Temp HOME dir created (if any) -- caller must clean up */
	tempHome: string | null;
}

// ---- PATH helpers ----

/**
 * Check if a directory contains a specific binary.
 */
function dirContainsBinary(dir: string, binary: string): boolean {
	try {
		return existsSync(join(dir, binary));
	} catch {
		return false;
	}
}

/**
 * Expand ~ to the real HOME directory in a path.
 */
function expandHome(p: string, home: string): string {
	if (p.startsWith("~/") || p === "~") {
		return join(home, p.slice(1));
	}
	return p;
}

/**
 * Filter PATH based on the sandbox pathFilter configuration.
 */
function filterPath(
	currentPath: string,
	config: SandboxConfig["pathFilter"],
	blockBinaries: string[],
	home: string,
): string {
	const dirs = currentPath.split(":");

	if (config.mode === "allowlist") {
		const allowPrefixes = config.allow.map((p: string) => expandHome(p, home));
		return dirs
			.filter((dir) =>
				allowPrefixes.some((prefix: string) => dir === prefix || dir.startsWith(`${prefix}/`)),
			)
			.join(":");
	}

	if (config.mode === "blocklist") {
		if (blockBinaries.length === 0 && config.block.length === 0) {
			return currentPath;
		}
		// For blocklist mode, we remove dirs that contain blocked binaries
		const allBlocked = [...config.block, ...blockBinaries];
		return dirs.filter((dir) => !allBlocked.some((bin) => dirContainsBinary(dir, bin))).join(":");
	}

	// mode: inherit (default)
	// Still need to strip dirs containing blockBinaries from services
	if (blockBinaries.length === 0) return currentPath;
	return dirs.filter((dir) => !blockBinaries.some((bin) => dirContainsBinary(dir, bin))).join(":");
}

// ---- Home isolation ----

/**
 * Create a temporary HOME directory with only allowed config dirs symlinked in.
 */
function createIsolatedHome(realHome: string, homeAccess: SandboxConfig["homeAccess"]): string {
	const tempHome = mkdtempSync(join(tmpdir(), "randal-home-"));

	// Symlink allowed config dirs
	const symlinkMap: [boolean, string[]][] = [
		[homeAccess.ssh, [".ssh"]],
		[homeAccess.gitconfig, [".gitconfig", ".config/git"]],
		[homeAccess.docker, [".docker"]],
		[homeAccess.aws, [".aws"]],
	];

	for (const [allowed, paths] of symlinkMap) {
		if (allowed) {
			for (const p of paths) {
				const src = join(realHome, p);
				const dest = join(tempHome, p);
				if (existsSync(src)) {
					// Ensure parent dir exists
					const parentDir = join(tempHome, p, "..");
					mkdirSync(resolve(parentDir), { recursive: true });
					try {
						symlinkSync(src, dest);
					} catch {
						// May already exist or be unable to symlink
					}
				}
			}
		}
	}

	return tempHome;
}

// ---- Main sandbox function ----

/**
 * Apply sandbox restrictions to a child process environment.
 *
 * When enforcement is "none", returns the env unchanged.
 * When enforcement is "env-scrub", applies:
 *   1. PATH filtering (allowlist/blocklist)
 *   2. Service type:none enforcement (strip binaries, scrub vars)
 *   3. Home access restrictions (SSH, git, Docker, AWS)
 *   4. Clean HOME creation if any homeAccess is false
 */
export function applySandbox(
	sandboxConfig: SandboxConfig | undefined,
	env: Record<string, string>,
	serviceResult?: ResolvedServices,
): SandboxResult {
	// Default: no enforcement
	if (!sandboxConfig || sandboxConfig.enforcement === "none") {
		return { env: { ...env }, tempHome: null };
	}

	// enforcement: env-scrub
	const realHome = env.HOME ?? process.env.HOME ?? "";
	let tempHome: string | null = null;

	// 1. Build set of vars to scrub (from type:none services)
	const scrubSet = new Set<string>();
	if (serviceResult) {
		for (const varName of serviceResult.scrubVars) {
			scrubSet.add(varName);
		}
	}

	// 3. Home access restrictions -- determine what to scrub/add
	const ha = sandboxConfig.homeAccess;
	const needIsolatedHome = !ha.ssh || !ha.gitconfig || !ha.docker || !ha.aws;

	if (!ha.ssh) {
		scrubSet.add("SSH_AUTH_SOCK");
	}

	if (!ha.aws) {
		// Mark all AWS_* vars for scrubbing
		for (const key of Object.keys(env)) {
			if (key.startsWith("AWS_")) {
				scrubSet.add(key);
			}
		}
	}

	// Build result env, excluding scrubbed keys
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!scrubSet.has(key)) {
			result[key] = value;
		}
	}

	// 2. PATH filtering
	if (result.PATH) {
		const blockBinaries = serviceResult?.blockBinaries ?? [];
		result.PATH = filterPath(result.PATH, sandboxConfig.pathFilter, blockBinaries, realHome);
	}

	// Apply home access restriction overrides
	if (!ha.ssh) {
		result.GIT_SSH_COMMAND = "/bin/false";
	}

	if (!ha.gitconfig) {
		result.GIT_CONFIG_GLOBAL = "/dev/null";
		result.GIT_TERMINAL_PROMPT = "0";
	}

	if (!ha.docker) {
		result.DOCKER_CONFIG = "/dev/null";
	}

	if (!ha.aws) {
		result.AWS_CONFIG_FILE = "/dev/null";
		result.AWS_SHARED_CREDENTIALS_FILE = "/dev/null";
	}

	// 4. Create isolated HOME if needed
	if (needIsolatedHome && realHome) {
		tempHome = createIsolatedHome(realHome, ha);
		result.HOME = tempHome;
	}

	return { env: result, tempHome };
}

/**
 * Clean up a temporary HOME directory created by the sandbox.
 */
export function cleanupTempHome(tempHome: string | null): void {
	if (!tempHome) return;
	try {
		const { rmSync } = require("node:fs") as typeof import("node:fs");
		rmSync(tempHome, { recursive: true, force: true });
	} catch {
		// Best effort cleanup
	}
}
