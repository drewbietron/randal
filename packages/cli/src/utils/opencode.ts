/**
 * Check if OpenCode CLI is installed
 * Returns info about the installation
 */
export function detectOpenCode(): {
	installed: boolean;
	version?: string;
	path?: string;
} {
	const which = Bun.spawnSync(["which", "opencode"]);
	if (which.exitCode !== 0) {
		return { installed: false };
	}

	const path = which.stdout.toString().trim();

	// Try to get version
	const versionProc = Bun.spawnSync(["opencode", "--version"]);
	const version = versionProc.exitCode === 0 ? versionProc.stdout.toString().trim() : undefined;

	return { installed: true, version, path };
}

/**
 * Install OpenCode CLI
 * Supports macOS (Homebrew + fallback) and Linux
 * Returns true if successful
 */
export async function installOpenCode(): Promise<boolean> {
	const platform = process.platform;

	// macOS: Try Homebrew first (fastest, stays up to date)
	if (platform === "darwin") {
		const brewCheck = Bun.spawnSync(["which", "brew"]);
		if (brewCheck.exitCode === 0) {
			console.log("  Installing OpenCode via Homebrew...");
			const install = Bun.spawnSync(["brew", "install", "anomalyco/tap/opencode"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (install.exitCode === 0) {
				return true;
			}
		}
	}

	// Primary method: bun global install (works in Docker and locally)
	console.log("  Installing OpenCode via bun...");
	const bunInstall = Bun.spawnSync(["bun", "add", "-g", "opencode-ai"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (bunInstall.exitCode === 0) {
		// Verify it works
		const verify = Bun.spawnSync(["opencode", "--version"]);
		if (verify.exitCode === 0) {
			return true;
		}
	}

	// Fallback: Official install script
	console.log("  Installing OpenCode via install script...");
	const scriptInstall = Bun.spawnSync(["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (scriptInstall.exitCode === 0) {
		const verify = Bun.spawnSync(["opencode", "--version"]);
		if (verify.exitCode === 0) {
			return true;
		}
	}

	return false;
}
