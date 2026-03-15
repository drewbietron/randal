import { existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

// ---- Types ----

export interface AuditProbeResult {
	name: string;
	status: "found" | "not_found" | "error";
	details: Record<string, unknown>;
}

export interface AuditReport {
	host: string;
	timestamp: string;
	probes: AuditProbeResult[];
	summary: {
		servicesDetected: string[];
		warnings: string[];
	};
}

// ---- Probe helpers ----

const PROBE_TIMEOUT_MS = 5000;

/**
 * Run a command in a subprocess with a timeout.
 * Returns stdout on success, null on failure.
 */
async function runProbeCommand(
	command: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
	try {
		const proc = Bun.spawn([command, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});

		const timeout = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// Process may already be dead
			}
		}, PROBE_TIMEOUT_MS);

		const [stdoutBuf, stderrBuf] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		clearTimeout(timeout);

		return { stdout: stdoutBuf, stderr: stderrBuf, exitCode };
	} catch {
		return null;
	}
}

// ---- Individual probes ----

/**
 * Probe: SSH keys in ~/.ssh/
 */
async function probeSSH(): Promise<AuditProbeResult> {
	const sshDir = join(process.env.HOME ?? "", ".ssh");
	try {
		if (!existsSync(sshDir)) {
			return { name: "ssh", status: "not_found", details: {} };
		}

		const entries = readdirSync(sshDir);
		const keyFiles = entries.filter((f) => f.startsWith("id_") && !f.endsWith(".pub"));

		if (keyFiles.length === 0) {
			return { name: "ssh", status: "not_found", details: {} };
		}

		// Get fingerprints for each key
		const keys: { file: string; type: string; fingerprint?: string }[] = [];
		for (const keyFile of keyFiles) {
			const keyPath = join(sshDir, keyFile);
			const result = await runProbeCommand("ssh-keygen", ["-l", "-f", keyPath]);
			if (result && result.exitCode === 0) {
				const parts = result.stdout.trim().split(/\s+/);
				keys.push({
					file: keyFile,
					type: parts[parts.length - 1]?.replace(/[()]/g, "") ?? "unknown",
					fingerprint: parts[1],
				});
			} else {
				keys.push({ file: keyFile, type: "unknown" });
			}
		}

		return {
			name: "ssh",
			status: "found",
			details: { keys, sshDir },
		};
	} catch (err) {
		return {
			name: "ssh",
			status: "error",
			details: { error: err instanceof Error ? err.message : String(err) },
		};
	}
}

/**
 * Probe: GitHub CLI auth status
 */
async function probeGitHub(): Promise<AuditProbeResult> {
	const result = await runProbeCommand("gh", ["auth", "status"]);
	if (!result) {
		return { name: "github-cli", status: "not_found", details: { reason: "gh not installed" } };
	}

	// gh auth status outputs to stderr
	const output = result.stderr || result.stdout;

	if (output.includes("Logged in") || output.includes("logged in")) {
		// Parse user and scopes
		const userMatch = output.match(/account\s+(\S+)/);
		const scopeMatch = output.match(/Token scopes:\s*(.+)/);
		return {
			name: "github-cli",
			status: "found",
			details: {
				user: userMatch?.[1] ?? "unknown",
				scopes: scopeMatch?.[1]?.trim() ?? "unknown",
				raw: output.trim(),
			},
		};
	}

	return {
		name: "github-cli",
		status: "not_found",
		details: { reason: "not authenticated" },
	};
}

/**
 * Probe: Git credential store configuration
 */
async function probeGitCredentialStore(): Promise<AuditProbeResult> {
	const gitconfigPath = join(process.env.HOME ?? "", ".gitconfig");
	try {
		if (!existsSync(gitconfigPath)) {
			return { name: "git-credential-store", status: "not_found", details: {} };
		}

		const content = readFileSync(gitconfigPath, "utf-8");
		const helperMatch =
			content.match(/credential\.helper\s*=\s*(.+)/i) ?? content.match(/helper\s*=\s*(.+)/i);

		if (helperMatch) {
			return {
				name: "git-credential-store",
				status: "found",
				details: { storeType: helperMatch[1].trim() },
			};
		}

		// Also check via git config command
		const result = await runProbeCommand("git", ["config", "--global", "credential.helper"]);
		if (result && result.exitCode === 0 && result.stdout.trim()) {
			return {
				name: "git-credential-store",
				status: "found",
				details: { storeType: result.stdout.trim() },
			};
		}

		return { name: "git-credential-store", status: "not_found", details: {} };
	} catch (err) {
		return {
			name: "git-credential-store",
			status: "error",
			details: { error: err instanceof Error ? err.message : String(err) },
		};
	}
}

/**
 * Probe: Google Cloud auth
 */
async function probeGCloud(): Promise<AuditProbeResult> {
	const result = await runProbeCommand("gcloud", ["auth", "list", "--format=json"]);
	if (!result) {
		return { name: "gcloud", status: "not_found", details: { reason: "gcloud not installed" } };
	}

	if (result.exitCode !== 0) {
		return { name: "gcloud", status: "not_found", details: { reason: "gcloud auth failed" } };
	}

	try {
		const accounts = JSON.parse(result.stdout);
		if (Array.isArray(accounts) && accounts.length > 0) {
			return {
				name: "gcloud",
				status: "found",
				details: {
					accounts: accounts.map((a: { account?: string; status?: string }) => ({
						account: a.account,
						status: a.status,
					})),
				},
			};
		}
	} catch {
		// Non-JSON output -- try parsing text
		if (result.stdout.includes("@")) {
			return {
				name: "gcloud",
				status: "found",
				details: { raw: result.stdout.trim() },
			};
		}
	}

	return { name: "gcloud", status: "not_found", details: { reason: "no accounts" } };
}

/**
 * Probe: AWS credentials
 */
async function probeAWS(): Promise<AuditProbeResult> {
	const awsDir = join(process.env.HOME ?? "", ".aws");
	const credFile = join(awsDir, "credentials");
	const configFile = join(awsDir, "config");
	const details: Record<string, unknown> = {};
	let found = false;

	// Check credentials file
	if (existsSync(credFile)) {
		try {
			const content = readFileSync(credFile, "utf-8");
			const profiles = [...content.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
			if (profiles.length > 0) {
				details.credentialProfiles = profiles;
				found = true;
			}
		} catch {
			// Can't read file
		}
	}

	// Check config file for region
	if (existsSync(configFile)) {
		try {
			const content = readFileSync(configFile, "utf-8");
			const regionMatch = content.match(/region\s*=\s*(\S+)/);
			if (regionMatch) {
				details.defaultRegion = regionMatch[1];
			}
		} catch {
			// Can't read file
		}
	}

	// Check AWS env vars
	const envVars: string[] = [];
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("AWS_") && process.env[key]) {
			envVars.push(key);
		}
	}
	if (envVars.length > 0) {
		details.envVars = envVars;
		found = true;
	}

	return {
		name: "aws",
		status: found ? "found" : "not_found",
		details,
	};
}

/**
 * Probe: Docker config
 */
async function probeDocker(): Promise<AuditProbeResult> {
	const dockerConfig = join(process.env.HOME ?? "", ".docker", "config.json");
	try {
		if (!existsSync(dockerConfig)) {
			return { name: "docker", status: "not_found", details: {} };
		}

		const content = readFileSync(dockerConfig, "utf-8");
		const config = JSON.parse(content);

		const registries: string[] = [];
		if (config.auths && typeof config.auths === "object") {
			registries.push(...Object.keys(config.auths));
		}

		if (registries.length === 0) {
			return { name: "docker", status: "not_found", details: { reason: "no registry auth" } };
		}

		return {
			name: "docker",
			status: "found",
			details: { registries },
		};
	} catch (err) {
		return {
			name: "docker",
			status: "error",
			details: { error: err instanceof Error ? err.message : String(err) },
		};
	}
}

/**
 * Probe: npm/bun auth tokens
 */
async function probeNpmAuth(): Promise<AuditProbeResult> {
	const npmrcPath = join(process.env.HOME ?? "", ".npmrc");
	try {
		if (!existsSync(npmrcPath)) {
			return { name: "npm-auth", status: "not_found", details: {} };
		}

		const content = readFileSync(npmrcPath, "utf-8");
		const registries: string[] = [];

		for (const line of content.split("\n")) {
			if (line.includes("_authToken") || line.includes("_auth")) {
				// Extract registry URL (everything before :_authToken)
				const match = line.match(/^\/\/(.+?)\//);
				if (match) {
					registries.push(match[1]);
				}
			}
		}

		if (registries.length === 0) {
			return { name: "npm-auth", status: "not_found", details: {} };
		}

		return {
			name: "npm-auth",
			status: "found",
			details: { registries },
		};
	} catch (err) {
		return {
			name: "npm-auth",
			status: "error",
			details: { error: err instanceof Error ? err.message : String(err) },
		};
	}
}

// ---- Main audit function ----

const ALL_PROBES = [
	probeSSH,
	probeGitHub,
	probeGitCredentialStore,
	probeGCloud,
	probeAWS,
	probeDocker,
	probeNpmAuth,
];

/**
 * Run all ambient auth probes and build an audit report.
 */
export async function runAudit(): Promise<AuditReport> {
	const probes = await Promise.all(ALL_PROBES.map((fn) => fn()));

	const servicesDetected = probes.filter((p) => p.status === "found").map((p) => p.name);

	const warnings: string[] = [];

	// Generate warnings for found ambient auth
	if (servicesDetected.includes("ssh")) {
		warnings.push(
			"SSH keys found -- agent processes can use SSH-based git operations and remote access",
		);
	}
	if (servicesDetected.includes("github-cli")) {
		warnings.push(
			"GitHub CLI is authenticated -- agent processes can push, create PRs, and manage repos",
		);
	}
	if (servicesDetected.includes("aws")) {
		warnings.push("AWS credentials found -- agent processes may have access to AWS services");
	}
	if (servicesDetected.includes("gcloud")) {
		warnings.push("Google Cloud auth found -- agent processes may have access to GCP services");
	}
	if (servicesDetected.includes("docker")) {
		warnings.push("Docker registry auth found -- agent processes can pull/push container images");
	}

	return {
		host: hostname(),
		timestamp: new Date().toISOString(),
		probes,
		summary: {
			servicesDetected,
			warnings,
		},
	};
}

/**
 * Format an audit report as a human-readable string.
 */
export function formatAuditReport(report: AuditReport): string {
	const lines: string[] = [];

	lines.push("\x1b[1mAmbient Auth Audit\x1b[0m");
	lines.push(`Host: ${report.host}`);
	lines.push(`Time: ${report.timestamp}`);
	lines.push("");

	lines.push("\x1b[1mProbes:\x1b[0m");
	for (const probe of report.probes) {
		const icon =
			probe.status === "found"
				? "\x1b[33m!\x1b[0m"
				: probe.status === "not_found"
					? "\x1b[32m-\x1b[0m"
					: "\x1b[31mx\x1b[0m";
		const statusColor =
			probe.status === "found" ? "\x1b[33m" : probe.status === "not_found" ? "\x1b[2m" : "\x1b[31m";
		lines.push(`  ${icon} ${probe.name}: ${statusColor}${probe.status}\x1b[0m`);

		if (probe.status === "found" && Object.keys(probe.details).length > 0) {
			for (const [key, value] of Object.entries(probe.details)) {
				if (key === "raw") continue; // Skip raw output
				const display = Array.isArray(value)
					? value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ")
					: String(value);
				lines.push(`      ${key}: ${display}`);
			}
		}
	}

	lines.push("");

	if (report.summary.warnings.length > 0) {
		lines.push("\x1b[1m\x1b[33mWarnings:\x1b[0m");
		for (const w of report.summary.warnings) {
			lines.push(`  \x1b[33m*\x1b[0m ${w}`);
		}
		lines.push("");
	}

	if (report.summary.servicesDetected.length > 0) {
		lines.push(`\x1b[1mServices detected:\x1b[0m ${report.summary.servicesDetected.join(", ")}`);
	} else {
		lines.push("\x1b[32mNo ambient auth detected.\x1b[0m");
	}

	return lines.join("\n");
}
