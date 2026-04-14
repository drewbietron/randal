import { join, resolve } from "node:path";

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

	// macOS: Try Homebrew first
	if (platform === "darwin") {
		const brewCheck = Bun.spawnSync(["which", "brew"]);
		if (brewCheck.exitCode === 0) {
			console.log("  Installing OpenCode via Homebrew...");
			const install = Bun.spawnSync(["brew", "install", "opencode"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (install.exitCode === 0) {
				return true;
			}
		}
	}

	// Fallback: Direct download to ~/.local/bin
	console.log("  Installing OpenCode via direct download...");

	const home = process.env.HOME || "~";
	const binDir = resolve(home, ".local", "bin");
	const opencodePath = join(binDir, "opencode");

	// Ensure ~/.local/bin exists
	const mkdir = Bun.spawnSync(["mkdir", "-p", binDir]);
	if (mkdir.exitCode !== 0) {
		return false;
	}

	// Determine architecture
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
	const os = platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu";

	// Download from GitHub releases
	const downloadUrl = `https://github.com/opencode-ai/opencode/releases/latest/download/opencode-${arch}-${os}`;

	const download = Bun.spawnSync(["curl", "-fsSL", "-o", opencodePath, downloadUrl], {
		stdout: "pipe",
		stderr: "pipe",
	});

	if (download.exitCode !== 0) {
		return false;
	}

	// Make executable
	const chmod = Bun.spawnSync(["chmod", "+x", opencodePath]);
	if (chmod.exitCode !== 0) {
		return false;
	}

	// Verify it works
	const verify = Bun.spawnSync([opencodePath, "--version"]);
	return verify.exitCode === 0;
}
