import {
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	compileOpenCodeConfig,
	loadConfig,
	resolvePromptArray,
	resolvePromptValue,
} from "@randal/core";
import type { CompileResult, PromptContext, RandalConfig, ResolvedIdentity } from "@randal/core";

// ---- Constants ----

/** Default OpenCode config directory */
const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");

/** Static content directories to symlink from agent/opencode-config/ */
const STATIC_CONTENT_ENTRIES = [
	"agents",
	"skills",
	"lenses",
	"tools",
	"rules",
	"plugins",
	"package.json",
	"tui.json",
];

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
 * Create a backup of an existing non-symlink entry before overwriting.
 * Returns the backup path if a backup was created, null otherwise.
 */
function backupIfNeeded(targetPath: string): string | null {
	if (!existsSync(targetPath)) return null;

	try {
		const stat = lstatSync(targetPath);
		if (stat.isSymbolicLink()) {
			// Remove stale symlink — will be recreated
			unlinkSync(targetPath);
			return null;
		}
	} catch {
		return null;
	}

	// Non-symlink exists — back it up
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = `${targetPath}.backup-${timestamp}`;
	renameSync(targetPath, backupPath);
	return backupPath;
}

/**
 * Create a symlink, removing any existing symlink first.
 * Handles both files and directories.
 */
function ensureSymlink(source: string, target: string): void {
	if (existsSync(target)) {
		const stat = lstatSync(target);
		if (stat.isSymbolicLink()) {
			unlinkSync(target);
		}
	}
	symlinkSync(source, target);
}

/**
 * Pre-resolve identity content from config for the compile step.
 * This handles async I/O (file reads, module imports) so that
 * the core compile function remains synchronous.
 */
async function resolveIdentityContent(
	config: RandalConfig,
	basePath: string,
): Promise<ResolvedIdentity> {
	const ctx: PromptContext = {
		basePath,
		vars: config.identity.vars,
		configName: config.name,
	};

	const result: ResolvedIdentity = {};

	// Resolve persona if set
	if (config.identity.persona) {
		try {
			result.persona = await resolvePromptValue(config.identity.persona, ctx);
		} catch (err) {
			console.warn(
				`  Warning: Could not resolve persona: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Resolve rules if any
	if (config.identity.rules.length > 0) {
		try {
			result.rules = await resolvePromptArray(config.identity.rules, ctx, { mode: "rules" });
		} catch (err) {
			console.warn(
				`  Warning: Could not resolve rules: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Resolve knowledge if any
	if (config.identity.knowledge.length > 0) {
		try {
			result.knowledge = await resolvePromptArray(config.identity.knowledge, ctx, {
				mode: "knowledge",
			});
		} catch (err) {
			console.warn(
				`  Warning: Could not resolve knowledge: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return result;
}

// ---- Core setup logic ----

export interface SetupOptions {
	/** Path to config file (optional — uses standard resolution) */
	configPath?: string;
	/** Output directory for opencode.json (defaults to ~/.config/opencode/) */
	outputDir?: string;
	/** Print what would happen without writing anything */
	dryRun?: boolean;
	/** Output raw JSON to stdout (for piping) */
	json?: boolean;
	/** Show detailed resolution steps */
	verbose?: boolean;
}

export interface SetupResult {
	/** The compiled OpenCode configuration */
	compileResult: CompileResult;
	/** Path where opencode.json was written (or would be written in dry-run) */
	outputPath: string;
	/** Symlinks that were created (source -> target) */
	symlinks: Array<{ source: string; target: string }>;
	/** Backups that were created */
	backups: string[];
	/** Whether plugin dependencies were installed */
	pluginsInstalled: boolean;
}

/**
 * Execute the setup: compile config, write opencode.json, symlink static content.
 */
export async function executeSetup(options: SetupOptions): Promise<SetupResult> {
	const repoRoot = getRepoRoot();
	const sourceConfigDir = getSourceConfigDir();
	const outputDir = options.outputDir ?? OPENCODE_CONFIG_DIR;
	const outputPath = join(outputDir, "opencode.json");

	// 1. Load config
	const config = loadConfig(options.configPath);
	const configDir = options.configPath ? resolve(options.configPath, "..") : process.cwd();

	if (options.verbose) {
		console.log(`  Config loaded: ${config.name}`);
		console.log(`  Repo root: ${repoRoot}`);
		console.log(`  Source config dir: ${sourceConfigDir}`);
		console.log(`  Output dir: ${outputDir}`);
	}

	// 2. Resolve identity content (async I/O)
	const resolvedIdentity = await resolveIdentityContent(config, configDir);

	if (options.verbose && resolvedIdentity.persona) {
		console.log(`  Persona resolved: ${resolvedIdentity.persona.length} chars`);
	}
	if (options.verbose && resolvedIdentity.rules) {
		console.log(`  Rules resolved: ${resolvedIdentity.rules.length} entries`);
	}

	// 3. Compile the OpenCode config
	const compileResult = compileOpenCodeConfig(config, {
		basePath: configDir,
		repoRoot,
		toolsDir: resolve(repoRoot, "tools"),
		resolvedIdentity,
	});

	if (options.verbose) {
		const mcpNames = Object.keys(compileResult.config.mcp);
		console.log(`  MCP servers: ${mcpNames.join(", ") || "(none)"}`);
		for (const name of mcpNames) {
			const entry = compileResult.config.mcp[name];
			const reason =
				entry.type === "remote" ? `remote: ${entry.url}` : `local: ${entry.command?.join(" ")}`;
			console.log(`    ${name}: ${reason}`);
		}
		const toolNames = Object.keys(compileResult.config.tools);
		if (toolNames.length > 0) {
			console.log(`  Tool permissions: ${toolNames.join(", ")}`);
		}
		console.log(`  Capabilities: ${config.capabilities.join(", ") || "(none)"}`);
	}

	// In dry-run mode, return without writing
	if (options.dryRun) {
		// Build the would-be symlink list
		const symlinks = STATIC_CONTENT_ENTRIES.filter((entry) =>
			existsSync(join(sourceConfigDir, entry)),
		).map((entry) => ({
			source: join(sourceConfigDir, entry),
			target: join(outputDir, entry),
		}));

		return {
			compileResult,
			outputPath,
			symlinks,
			backups: [],
			pluginsInstalled: false,
		};
	}

	// 4. Ensure output directory exists
	mkdirSync(outputDir, { recursive: true });

	// 5. Write opencode.json
	const backups: string[] = [];
	const backup = backupIfNeeded(outputPath);
	if (backup) backups.push(backup);

	writeFileSync(outputPath, `${JSON.stringify(compileResult.config, null, "\t")}\n`, "utf-8");

	// 6. Symlink/copy static content directories
	const symlinks: Array<{ source: string; target: string }> = [];

	if (!existsSync(sourceConfigDir)) {
		console.warn(`  Warning: Source config directory not found: ${sourceConfigDir}`);
	} else {
		for (const entry of STATIC_CONTENT_ENTRIES) {
			const sourcePath = join(sourceConfigDir, entry);
			const targetPath = join(outputDir, entry);

			if (!existsSync(sourcePath)) {
				if (options.verbose) {
					console.log(`  Skipping ${entry} (not found in source)`);
				}
				continue;
			}

			const entryBackup = backupIfNeeded(targetPath);
			if (entryBackup) backups.push(entryBackup);

			ensureSymlink(sourcePath, targetPath);
			symlinks.push({ source: sourcePath, target: targetPath });
		}
	}

	// 7. Install plugin dependencies if package.json exists
	let pluginsInstalled = false;
	const packageJsonTarget = join(outputDir, "package.json");
	if (existsSync(packageJsonTarget)) {
		try {
			const proc = Bun.spawn(["bun", "install"], {
				cwd: outputDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			pluginsInstalled = exitCode === 0;
			if (!pluginsInstalled) {
				const stderr = await new Response(proc.stderr).text();
				console.warn(`  Warning: Plugin install failed: ${stderr.trim()}`);
			}
		} catch (err) {
			console.warn(
				`  Warning: Could not install plugins: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return {
		compileResult,
		outputPath,
		symlinks,
		backups,
		pluginsInstalled,
	};
}

// ---- CLI command ----

/**
 * `randal setup` — Generate opencode.json and set up the OpenCode config directory.
 */
export async function setupCommand(args: string[]): Promise<void> {
	const dryRun = args.includes("--dry-run");
	const jsonOutput = args.includes("--json");
	const verbose = args.includes("--verbose");

	// Parse --config flag (may appear in args forwarded from cli.ts)
	const configIdx = args.indexOf("--config");
	const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

	// Parse --output flag for custom output directory
	const outputIdx = args.indexOf("--output");
	const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

	if (args.includes("--help") || args.includes("-h")) {
		printSetupHelp();
		return;
	}

	try {
		const result = await executeSetup({
			configPath,
			outputDir,
			dryRun,
			json: jsonOutput,
			verbose,
		});

		if (jsonOutput) {
			// Raw JSON output for piping
			console.log(JSON.stringify(result.compileResult.config, null, "\t"));
			return;
		}

		if (dryRun) {
			console.log("\n  [dry-run] Generated opencode.json:\n");
			console.log(JSON.stringify(result.compileResult.config, null, "\t"));
			console.log(`\n  [dry-run] Would write to: ${result.outputPath}`);
			if (result.symlinks.length > 0) {
				console.log("\n  [dry-run] Would create symlinks:");
				for (const link of result.symlinks) {
					console.log(`    ${basename(link.target)} -> ${link.source}`);
				}
			}
			// Show plugin install intent
			const sourceConfigDir = getSourceConfigDir();
			const packageJsonSource = join(sourceConfigDir, "package.json");
			if (existsSync(packageJsonSource)) {
				console.log("\n  [dry-run] Would run: bun install (plugin dependencies)");
			}
			// Show identity resolution summary
			if (result.compileResult.resolvedPersona) {
				const preview = result.compileResult.resolvedPersona.slice(0, 100).replace(/\n/g, " ");
				console.log(`\n  [dry-run] Resolved persona: ${preview}...`);
			}
			if (result.compileResult.resolvedRules && result.compileResult.resolvedRules.length > 0) {
				console.log(
					`  [dry-run] Resolved rules: ${result.compileResult.resolvedRules.length} entries`,
				);
			}
			return;
		}

		// Print summary
		console.log("\n  Setup complete:\n");
		console.log(`    opencode.json -> ${result.outputPath}`);

		if (result.symlinks.length > 0) {
			console.log("\n    Symlinks:");
			for (const link of result.symlinks) {
				console.log(`      ${basename(link.target)} -> ${link.source}`);
			}
		}

		if (result.backups.length > 0) {
			console.log("\n    Backups:");
			for (const backup of result.backups) {
				console.log(`      ${backup}`);
			}
		}

		if (result.pluginsInstalled) {
			console.log("\n    Plugins installed successfully.");
		}

		// Show identity info if resolved
		if (result.compileResult.resolvedPersona) {
			const preview = result.compileResult.resolvedPersona.slice(0, 80).replace(/\n/g, " ");
			console.log(`\n    Persona: ${preview}...`);
		}

		console.log("");
	} catch (err) {
		console.error(`\n  Setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}

function printSetupHelp(): void {
	console.log(`
  randal setup — Generate opencode.json and configure the OpenCode runtime

  Usage:
    randal setup [options]

  Options:
    --config <path>    Path to randal.config.yaml
    --output <dir>     Output directory (default: ~/.config/opencode/)
    --dry-run          Print generated config without writing anything
    --json             Output raw JSON to stdout (for piping)
    --verbose          Show detailed resolution steps
    --help             Show this help

  Description:
    Reads randal.config.yaml and generates a valid opencode.json with
    MCP server wiring, tool permissions, and identity resolution.

    Also symlinks static content (agents, skills, lenses, rules, plugins)
    from agent/opencode-config/ into ~/.config/opencode/.

    This command replaces the functionality of agent/setup.sh and is
    idempotent — safe to run multiple times.
`);
}
