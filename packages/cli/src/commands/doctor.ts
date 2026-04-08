import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	compileOpenCodeConfig,
	loadConfig,
	resolvePromptValue,
	resolvePromptArray,
} from "@randal/core";
import type { RandalConfig, PromptContext, OpenCodeConfig } from "@randal/core";

// ---- Constants ----

/** Default OpenCode config directory */
const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");

/** Static content entries that should be symlinked */
const EXPECTED_SYMLINKS = [
	"agents",
	"skills",
	"lenses",
	"tools",
	"rules",
	"plugins",
	"package.json",
	"tui.json",
];

// ---- Check result types ----

type CheckStatus = "pass" | "fail" | "warn";

interface CheckResult {
	name: string;
	status: CheckStatus;
	message: string;
	detail?: string;
}

// ---- Helpers ----

/** Resolve the root directory of the Randal repository. */
function getRepoRoot(): string {
	return resolve(import.meta.dir, "../../../../..");
}

/** Resolve the agent/opencode-config source directory. */
function getSourceConfigDir(): string {
	return resolve(getRepoRoot(), "agent", "opencode-config");
}

/**
 * Check if a binary is available on PATH.
 */
function isOnPath(binary: string): boolean {
	try {
		const proc = Bun.spawnSync(["which", binary], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Check if a URL responds to a health check.
 */
async function isHealthy(url: string, timeoutMs = 3000): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const response = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		return response.ok;
	} catch {
		return false;
	}
}

// ---- Individual checks ----

/**
 * Check 1: Config parses correctly.
 */
function checkConfigParse(configPath?: string): CheckResult {
	try {
		loadConfig(configPath);
		return {
			name: "Config",
			status: "pass",
			message: "randal.config.yaml parses correctly",
		};
	} catch (err) {
		return {
			name: "Config",
			status: "fail",
			message: "Config parse failed",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Check 2: opencode.json exists at expected location.
 */
function checkOpenCodeJsonExists(outputDir: string): CheckResult {
	const jsonPath = join(outputDir, "opencode.json");
	if (existsSync(jsonPath)) {
		return {
			name: "opencode.json",
			status: "pass",
			message: `opencode.json exists at ${jsonPath}`,
		};
	}
	return {
		name: "opencode.json",
		status: "fail",
		message: `opencode.json not found at ${jsonPath}`,
		detail: "Run `randal setup` to generate it.",
	};
}

/**
 * Check 3: Generated opencode.json matches current config (stale detection).
 *
 * Compiles the config fresh and compares key sections (MCP servers, tools,
 * plugins, agent settings) with what's on disk. Structural comparison — not
 * exact byte equality — since formatting may differ.
 */
function checkOpenCodeJsonFresh(config: RandalConfig, outputDir: string): CheckResult {
	const jsonPath = join(outputDir, "opencode.json");

	if (!existsSync(jsonPath)) {
		return {
			name: "Config freshness",
			status: "warn",
			message: "Cannot check freshness — opencode.json missing",
		};
	}

	let diskConfig: OpenCodeConfig;
	try {
		const raw = readFileSync(jsonPath, "utf-8");
		diskConfig = JSON.parse(raw) as OpenCodeConfig;
	} catch (err) {
		return {
			name: "Config freshness",
			status: "fail",
			message: "opencode.json is not valid JSON",
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	const repoRoot = getRepoRoot();
	const compiled = compileOpenCodeConfig(config, {
		basePath: process.cwd(),
		repoRoot,
		toolsDir: resolve(repoRoot, "tools"),
	});

	// Compare key structural elements
	const staleReasons: string[] = [];

	// Compare MCP server keys
	const diskMcpKeys = Object.keys(diskConfig.mcp ?? {}).sort();
	const compiledMcpKeys = Object.keys(compiled.config.mcp ?? {}).sort();
	if (JSON.stringify(diskMcpKeys) !== JSON.stringify(compiledMcpKeys)) {
		staleReasons.push(
			`MCP servers differ: disk=[${diskMcpKeys.join(",")}] vs config=[${compiledMcpKeys.join(",")}]`,
		);
	}

	// Compare tool permissions keys
	const diskToolKeys = Object.keys(diskConfig.tools ?? {}).sort();
	const compiledToolKeys = Object.keys(compiled.config.tools ?? {}).sort();
	if (JSON.stringify(diskToolKeys) !== JSON.stringify(compiledToolKeys)) {
		staleReasons.push(
			`Tool permissions differ: disk=[${diskToolKeys.join(",")}] vs config=[${compiledToolKeys.join(",")}]`,
		);
	}

	// Compare plugin list
	const diskPlugins = (diskConfig.plugin ?? []).sort();
	const compiledPlugins = (compiled.config.plugin ?? []).sort();
	if (JSON.stringify(diskPlugins) !== JSON.stringify(compiledPlugins)) {
		staleReasons.push("Plugin list differs");
	}

	if (staleReasons.length > 0) {
		return {
			name: "Config freshness",
			status: "warn",
			message: "opencode.json may be stale — run `randal setup` to regenerate",
			detail: staleReasons.join("; "),
		};
	}

	return {
		name: "Config freshness",
		status: "pass",
		message: "opencode.json is consistent with current config",
	};
}

/**
 * Check 4: Identity files referenced in config resolve correctly.
 */
async function checkIdentityFiles(config: RandalConfig): Promise<CheckResult> {
	const issues: string[] = [];

	const ctx: PromptContext = {
		basePath: process.cwd(),
		vars: config.identity.vars,
		configName: config.name,
	};

	// Check persona
	if (config.identity.persona) {
		try {
			await resolvePromptValue(config.identity.persona, ctx);
		} catch (err) {
			issues.push(`persona: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Check rules
	if (config.identity.rules.length > 0) {
		try {
			await resolvePromptArray(config.identity.rules, ctx, { mode: "rules" });
		} catch (err) {
			issues.push(`rules: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Check knowledge
	if (config.identity.knowledge.length > 0) {
		try {
			await resolvePromptArray(config.identity.knowledge, ctx, { mode: "knowledge" });
		} catch (err) {
			issues.push(`knowledge: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (issues.length === 0) {
		const parts: string[] = [];
		if (config.identity.persona) parts.push("persona");
		if (config.identity.rules.length > 0) parts.push(`${config.identity.rules.length} rules`);
		if (config.identity.knowledge.length > 0)
			parts.push(`${config.identity.knowledge.length} knowledge entries`);

		return {
			name: "Identity files",
			status: "pass",
			message:
				parts.length > 0
					? `All identity files resolve (${parts.join(", ")})`
					: "No identity files configured",
		};
	}

	return {
		name: "Identity files",
		status: "fail",
		message: `${issues.length} identity resolution failure(s)`,
		detail: issues.join("\n"),
	};
}

/**
 * Check 5: MCP server binaries/scripts exist on disk.
 */
function checkMcpServerBinaries(outputDir: string): CheckResult {
	const jsonPath = join(outputDir, "opencode.json");

	if (!existsSync(jsonPath)) {
		return {
			name: "MCP servers",
			status: "warn",
			message: "Cannot check MCP servers — opencode.json missing",
		};
	}

	let config: OpenCodeConfig;
	try {
		config = JSON.parse(readFileSync(jsonPath, "utf-8")) as OpenCodeConfig;
	} catch {
		return {
			name: "MCP servers",
			status: "fail",
			message: "Cannot parse opencode.json to check MCP servers",
		};
	}

	const issues: string[] = [];
	const checked: string[] = [];

	for (const [name, entry] of Object.entries(config.mcp ?? {})) {
		if (entry.type === "remote") {
			checked.push(`${name} (remote)`);
			continue;
		}

		if (entry.command && entry.command.length >= 3) {
			// command is typically ["bun", "run", "/path/to/script.ts"]
			const scriptPath = entry.command[entry.command.length - 1];
			if (existsSync(scriptPath)) {
				checked.push(name);
			} else {
				issues.push(`${name}: script not found at ${scriptPath}`);
			}
		} else if (entry.command && entry.command.length > 0) {
			// Check if the binary exists on PATH
			const binary = entry.command[0];
			if (isOnPath(binary)) {
				checked.push(name);
			} else {
				issues.push(`${name}: binary '${binary}' not found on PATH`);
			}
		}
	}

	if (issues.length > 0) {
		return {
			name: "MCP servers",
			status: "fail",
			message: `${issues.length} MCP server(s) have missing binaries`,
			detail: issues.join("\n"),
		};
	}

	return {
		name: "MCP servers",
		status: "pass",
		message: `All MCP server scripts exist (${checked.join(", ")})`,
	};
}

/**
 * Check 6: Meilisearch is healthy (if memory is configured).
 */
async function checkMeilisearch(config: RandalConfig): Promise<CheckResult> {
	if (!config.memory.store) {
		return {
			name: "Meilisearch",
			status: "pass",
			message: "Memory not configured — skipping Meilisearch check",
		};
	}

	const url = config.memory.url;
	const healthUrl = `${url}/health`;

	const healthy = await isHealthy(healthUrl);
	if (healthy) {
		return {
			name: "Meilisearch",
			status: "pass",
			message: `Meilisearch is healthy at ${url}`,
		};
	}

	return {
		name: "Meilisearch",
		status: "warn",
		message: `Meilisearch not reachable at ${url}`,
		detail: `Health check failed: ${healthUrl}. Memory features will not work until Meilisearch is running.`,
	};
}

/**
 * Check 7: `opencode` binary is available on PATH.
 */
function checkOpenCodeBinary(): CheckResult {
	if (isOnPath("opencode")) {
		return {
			name: "OpenCode CLI",
			status: "pass",
			message: "`opencode` is available on PATH",
		};
	}

	return {
		name: "OpenCode CLI",
		status: "fail",
		message: "`opencode` not found on PATH",
		detail: "Install OpenCode: https://opencode.ai",
	};
}

/**
 * Check 8: Symlinks in ~/.config/opencode/ point to valid targets.
 */
function checkSymlinks(outputDir: string): CheckResult {
	const sourceConfigDir = getSourceConfigDir();
	const issues: string[] = [];
	const valid: string[] = [];

	for (const entry of EXPECTED_SYMLINKS) {
		const targetPath = join(outputDir, entry);
		const expectedSource = join(sourceConfigDir, entry);

		if (!existsSync(targetPath)) {
			// Not all entries are required — only warn for key directories
			if (["agents", "skills", "rules"].includes(entry)) {
				issues.push(`${entry}: missing (expected at ${targetPath})`);
			}
			continue;
		}

		try {
			const stat = lstatSync(targetPath);
			if (stat.isSymbolicLink()) {
				const realTarget = realpathSync(targetPath);
				const expectedReal = realpathSync(expectedSource);
				if (realTarget === expectedReal) {
					valid.push(entry);
				} else {
					issues.push(`${entry}: symlink points to ${realTarget}, expected ${expectedReal}`);
				}
			} else {
				// Not a symlink but exists — it's a copy, which is fine but note it
				valid.push(`${entry} (copy)`);
			}
		} catch (err) {
			issues.push(
				`${entry}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (issues.length > 0) {
		return {
			name: "Symlinks",
			status: "warn",
			message: `${issues.length} symlink issue(s)`,
			detail: issues.join("\n"),
		};
	}

	if (valid.length === 0) {
		return {
			name: "Symlinks",
			status: "warn",
			message: "No symlinks found — run `randal setup` to create them",
		};
	}

	return {
		name: "Symlinks",
		status: "pass",
		message: `${valid.length} symlinks OK (${valid.join(", ")})`,
	};
}

// ---- Formatting ----

function statusIcon(status: CheckStatus): string {
	switch (status) {
		case "pass":
			return "\x1b[32mPASS\x1b[0m";
		case "fail":
			return "\x1b[31mFAIL\x1b[0m";
		case "warn":
			return "\x1b[33mWARN\x1b[0m";
	}
}

function printResult(result: CheckResult): void {
	console.log(`  [${statusIcon(result.status)}] ${result.name}: ${result.message}`);
	if (result.detail) {
		for (const line of result.detail.split("\n")) {
			console.log(`         ${line}`);
		}
	}
}

// ---- Public API ----

export interface DoctorOptions {
	/** Path to config file (optional — uses standard resolution) */
	configPath?: string;
	/** OpenCode config directory to check (defaults to ~/.config/opencode/) */
	outputDir?: string;
}

export interface DoctorResult {
	checks: CheckResult[];
	passed: number;
	warned: number;
	failed: number;
}

/**
 * Run all diagnostic checks and return structured results.
 */
export async function runDiagnostics(options: DoctorOptions): Promise<DoctorResult> {
	const outputDir = options.outputDir ?? OPENCODE_CONFIG_DIR;
	const checks: CheckResult[] = [];

	// Check 1: Config parse
	const configCheck = checkConfigParse(options.configPath);
	checks.push(configCheck);

	// If config doesn't parse, we can't run config-dependent checks
	let config: RandalConfig | null = null;
	if (configCheck.status !== "fail") {
		try {
			config = loadConfig(options.configPath);
		} catch {
			// Already caught above
		}
	}

	// Check 2: opencode.json exists
	checks.push(checkOpenCodeJsonExists(outputDir));

	// Check 3: Config freshness (needs config)
	if (config) {
		checks.push(checkOpenCodeJsonFresh(config, outputDir));
	}

	// Check 4: Identity files (needs config)
	if (config) {
		checks.push(await checkIdentityFiles(config));
	}

	// Check 5: MCP server binaries
	checks.push(checkMcpServerBinaries(outputDir));

	// Check 6: Meilisearch health (needs config)
	if (config) {
		checks.push(await checkMeilisearch(config));
	}

	// Check 7: opencode binary
	checks.push(checkOpenCodeBinary());

	// Check 8: Symlinks
	checks.push(checkSymlinks(outputDir));

	const passed = checks.filter((c) => c.status === "pass").length;
	const warned = checks.filter((c) => c.status === "warn").length;
	const failed = checks.filter((c) => c.status === "fail").length;

	return { checks, passed, warned, failed };
}

// ---- CLI command ----

/**
 * `randal doctor` — Validate the current deployment.
 */
export async function doctorCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		printDoctorHelp();
		return;
	}

	// Parse --config flag
	const configIdx = args.indexOf("--config");
	const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

	// Parse --output flag for custom output directory
	const outputIdx = args.indexOf("--output");
	const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

	console.log("\n  Randal Doctor — deployment validation\n");

	const result = await runDiagnostics({ configPath, outputDir });

	for (const check of result.checks) {
		printResult(check);
	}

	console.log("");
	console.log(
		`  Summary: ${result.passed} passed, ${result.warned} warned, ${result.failed} failed`,
	);
	console.log("");

	if (result.failed > 0) {
		process.exit(1);
	}
}

function printDoctorHelp(): void {
	console.log(`
  randal doctor — Validate the current deployment

  Usage:
    randal doctor [options]

  Options:
    --config <path>    Path to randal.config.yaml
    --output <dir>     OpenCode config directory to check (default: ~/.config/opencode/)
    --help             Show this help

  Description:
    Runs a series of diagnostic checks to validate that the current
    deployment is correctly configured:

      - Config parses correctly
      - opencode.json exists and is fresh
      - Identity files resolve (persona, rules, knowledge)
      - MCP server binaries/scripts exist
      - Meilisearch is healthy (if memory configured)
      - OpenCode CLI is installed
      - Symlinks are correct

    Exit code 0 if all checks pass, 1 if any fail.
`);
}
