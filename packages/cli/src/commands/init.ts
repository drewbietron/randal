import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	cancel,
	confirm,
	group,
	intro,
	isCancel,
	log,
	note,
	outro,
	select,
	spinner,
	text,
} from "@clack/prompts";
import { configSchema } from "@randal/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ── Helpers ──────────────────────────────────────────────────────────────

function handleCancel(value: unknown): void {
	if (isCancel(value)) {
		cancel("Operation cancelled. No files were written.");
		process.exit(0);
	}
}

function detectAgentCLIs(): { name: string; found: boolean }[] {
	const clis = ["opencode", "claude", "codex"];
	return clis.map((name) => {
		try {
			const proc = Bun.spawnSync(["which", name]);
			return { name: name === "claude" ? "claude-code" : name, found: proc.exitCode === 0 };
		} catch {
			return { name: name === "claude" ? "claude-code" : name, found: false };
		}
	});
}

async function detectMeilisearch(): Promise<boolean> {
	try {
		const res = await fetch("http://localhost:7700/health", {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function startMessagesApp(): boolean {
	if (process.platform !== "darwin") return false;
	try {
		const proc = Bun.spawnSync(["osascript", "-e", 'tell application "Messages" to activate'], {
			timeout: 10_000,
		});
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

async function ensureMeilisearch(): Promise<{ started: boolean; apiKey?: string }> {
	// Already running?
	if (await detectMeilisearch()) {
		return { started: true };
	}

	// Need Docker
	const dockerCheck = Bun.spawnSync(["which", "docker"]);
	if (dockerCheck.exitCode !== 0) {
		return { started: false };
	}

	// Generate a master key
	const keyProc = Bun.spawnSync(["openssl", "rand", "-hex", "16"]);
	const apiKey = keyProc.stdout.toString().trim();
	if (!apiKey) return { started: false };

	// Create data directory
	const dataDir = resolve(process.env.HOME ?? "~", ".randal", "meili-data");
	mkdirSync(dataDir, { recursive: true });

	// Remove existing container if any
	Bun.spawnSync(["docker", "rm", "-f", "randal-meilisearch"]);

	// Start Meilisearch
	const proc = Bun.spawnSync([
		"docker",
		"run",
		"-d",
		"--name",
		"randal-meilisearch",
		"--restart",
		"unless-stopped",
		"-p",
		"7700:7700",
		"-v",
		`${dataDir}:/meili_data`,
		"-e",
		`MEILI_MASTER_KEY=${apiKey}`,
		"getmeili/meilisearch:v1.12",
	]);

	if (proc.exitCode !== 0) return { started: false };

	// Wait for healthy
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		if (await detectMeilisearch()) return { started: true, apiKey };
	}

	return { started: true, apiKey };
}

async function ensureClaudeCode(): Promise<boolean> {
	// Check if already installed
	const check = Bun.spawnSync(["which", "claude"]);
	if (check.exitCode === 0) return true;

	// Try installing via npm (most reliable for global CLIs)
	const npmCheck = Bun.spawnSync(["which", "npm"]);
	if (npmCheck.exitCode === 0) {
		const install = Bun.spawnSync(["npm", "install", "-g", "@anthropic-ai/claude-code"], {
			timeout: 120_000,
		});
		return install.exitCode === 0;
	}

	// Fallback to bun
	const install = Bun.spawnSync(["bun", "add", "-g", "@anthropic-ai/claude-code"], {
		timeout: 120_000,
	});
	return install.exitCode === 0;
}

/**
 * Append key=value entries to .env, creating the file if needed.
 * Skips keys that already exist in the file.
 */
function appendEnvValues(envPath: string, entries: Record<string, string>): void {
	let existing = "";
	if (existsSync(envPath)) {
		existing = readFileSync(envPath, "utf-8");
	}

	const lines: string[] = [];
	for (const [key, value] of Object.entries(entries)) {
		if (value && !existing.includes(`${key}=`)) {
			lines.push(`${key}=${value}`);
		}
	}

	if (lines.length > 0) {
		const suffix = `${existing && !existing.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`;
		writeFileSync(envPath, existing + suffix, "utf-8");
	}
}

function buildConfigYaml(opts: {
	name: string;
	workdir: string;
	agent: string;
	model?: string;
	persona?: string;
	useMeilisearch: boolean;
	heartbeatEnabled?: boolean;
	heartbeatEvery?: string;
	hooksEnabled?: boolean;
	port?: number;
	maxIterations?: number;
	discordEnabled?: boolean;
	discordAllowFrom?: string[];
	imessageEnabled?: boolean;
	imessageAllowFrom?: string[];
	useTypeScriptIdentity?: boolean;
}): string {
	const lines: string[] = [
		"# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"# 🤠 Randal Agent Configuration",
		"# See docs/config-reference.md for full documentation",
		"# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"",
		`name: ${opts.name}`,
		'version: "0.1"',
		"",
		"identity:",
		`  persona: ${opts.useTypeScriptIdentity ? "./identity.ts" : "./IDENTITY.md"}`,
		"  vars:",
		`    name: ${opts.name}`,
		"  rules:",
		'    - "ALWAYS verify your work before marking complete"',
		"",
		"runner:",
		`  defaultAgent: ${opts.agent}`,
		`  defaultModel: ${opts.model ?? "anthropic/claude-sonnet-4"}`,
		`  defaultMaxIterations: ${opts.maxIterations ?? 20}`,
		`  workdir: ${opts.workdir}`,
		'  completionPromise: "DONE"',
		"",
		"credentials:",
		"  envFile: ./.env",
		"  allow:",
		"    - ANTHROPIC_API_KEY",
		"  inherit: [PATH, HOME, SHELL, TERM]",
		"",
		"gateway:",
		"  channels:",
		"    - type: http",
		`      port: ${opts.port ?? 7600}`,
		'      auth: "${RANDAL_API_TOKEN}"',
	];

	if (opts.discordEnabled) {
		lines.push("    - type: discord", '      token: "${DISCORD_BOT_TOKEN}"');
		if (opts.discordAllowFrom && opts.discordAllowFrom.length > 0) {
			lines.push(`      allowFrom: [${opts.discordAllowFrom.map((id) => `"${id}"`).join(", ")}]`);
		} else {
			lines.push('      # allowFrom: ["your-discord-user-id"]');
		}
	}

	if (opts.imessageEnabled) {
		lines.push(
			"    - type: imessage",
			"      provider: bluebubbles",
			'      url: "${BLUEBUBBLES_URL}"',
			'      password: "${BLUEBUBBLES_PASSWORD}"',
		);
		if (opts.imessageAllowFrom && opts.imessageAllowFrom.length > 0) {
			lines.push(`      allowFrom: [${opts.imessageAllowFrom.map((p) => `"${p}"`).join(", ")}]`);
		} else {
			lines.push('      # allowFrom: ["+15551234567"]');
		}
	}

	lines.push("");

	// Memory section
	if (opts.useMeilisearch) {
		lines.push(
			"memory:",
			"  store: meilisearch",
			"  url: http://localhost:7700",
			'  apiKey: "${MEILI_MASTER_KEY}"',
			`  index: memory-${opts.name}`,
			"  embedder:",
			"    type: builtin",
			"  autoInject:",
			"    enabled: true",
			"    maxResults: 5",
		);
	} else {
		lines.push(
			"memory:",
			"  store: file",
			"  files: [MEMORY.md]",
			"  embedder:",
			"    type: builtin",
			"  autoInject:",
			"    enabled: true",
			"    maxResults: 5",
		);
	}

	lines.push("");

	// Heartbeat section
	if (opts.heartbeatEnabled) {
		lines.push(
			"heartbeat:",
			"  enabled: true",
			`  every: ${opts.heartbeatEvery ?? "30m"}`,
			"  prompt: ./HEARTBEAT.md",
			'  target: "none"',
		);
	} else {
		lines.push("# heartbeat:", "#   enabled: true", "#   every: 30m", "#   prompt: ./HEARTBEAT.md");
	}

	lines.push("");

	// Cron section (always commented by default)
	lines.push(
		"# cron:",
		"#   jobs:",
		"#     morning-briefing:",
		'#       schedule: "0 8 * * *"',
		'#       prompt: "Review pending tasks and compile a morning status."',
		"#       execution: isolated",
		"#       announce: true",
	);

	lines.push("");

	// Hooks section
	if (opts.hooksEnabled) {
		lines.push("hooks:", "  enabled: true", '  token: "${RANDAL_HOOK_TOKEN}"');
	} else {
		lines.push("# hooks:", "#   enabled: true", '#   token: "${RANDAL_HOOK_TOKEN}"');
	}

	lines.push("", "tools: []", "", "tracking:", "  tokenPricing: {}", "");

	return lines.join("\n");
}

function generateEnvTemplate(opts?: {
	discordEnabled?: boolean;
	imessageEnabled?: boolean;
	anthropicApiKey?: string;
	discordToken?: string;
	blueBubblesUrl?: string;
	blueBubblesPassword?: string;
}): string {
	const lines = [
		"# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"# 🤠 Randal Environment Variables",
		"# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"",
		"# Required: your Anthropic API key",
		`ANTHROPIC_API_KEY=${opts?.anthropicApiKey ?? ""}`,
		"",
		"# Gateway auth token (any random string)",
		"RANDAL_API_TOKEN=",
		"",
		"# Meilisearch master key (if using meilisearch memory)",
		"# MEILI_MASTER_KEY=",
		"",
		"# Hook token (for webhook authentication)",
		"# RANDAL_HOOK_TOKEN=",
	];

	if (opts?.discordEnabled) {
		lines.push("", "# Discord bot token", `DISCORD_BOT_TOKEN=${opts.discordToken ?? ""}`);
	}

	if (opts?.imessageEnabled) {
		lines.push(
			"",
			"# BlueBubbles iMessage bridge (macOS only)",
			`BLUEBUBBLES_URL=${opts.blueBubblesUrl ?? "http://localhost:1234"}`,
			`BLUEBUBBLES_PASSWORD=${opts.blueBubblesPassword ?? ""}`,
			"",
			"# Apple ID for iMessage (ensure Messages.app is signed in with this account)",
			"APPLE_ID=",
		);
	}

	lines.push("");
	return lines.join("\n");
}

// ── Prompt Template Files ───────────────────────────────────────────────

const IDENTITY_MD_TEMPLATE = `# {{name}}

You are {{name}}, a helpful AI assistant.

## Responsibilities
- Respond to user requests accurately and concisely
- Escalate issues you cannot resolve
- Maintain a record of your work in MEMORY.md

## Tone
- Professional and friendly
- Clear and concise
- Honest about limitations
`;

const HEARTBEAT_MD_TEMPLATE = `# Heartbeat Checklist

- Check for any failed jobs that may need retry or human attention
- Review memory for tasks marked as follow-up
- If any background process crashed, log it
- If idle for 8+ hours, send a brief status update
`;

function buildIdentityTsTemplate(_name: string): string {
	return `import type { PromptContext } from "@randal/core";

export default function buildIdentity(ctx: PromptContext): string {
	return \`# \${ctx.vars?.name ?? "Agent"}

You are \${ctx.vars?.name ?? "a helpful AI assistant"}.

## Responsibilities
- Respond to user requests accurately and concisely
- Escalate issues you cannot resolve
- Maintain a record of your work in MEMORY.md
\`;
}
`;
}

// ── ASCII Banner ────────────────────────────────────────────────────────

const BANNER = `
  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
  ┃                                                 ┃
  ┃   🤠  R A N D A L                               ┃
  ┃                                                 ┃
  ┃   The composable harness for autonomous          ┃
  ┃   AI agent posses.                               ┃
  ┃                                                 ┃
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
`;

// ── Environment Detection ───────────────────────────────────────────────

interface EnvDetection {
	platform: string;
	clis: { name: string; found: boolean }[];
	hasMeili: boolean;
}

async function detectEnvironment(): Promise<EnvDetection> {
	const s = spinner();
	s.start("Scanning your environment...");

	const platform = process.platform;
	const clis = detectAgentCLIs();
	const hasMeili = await detectMeilisearch();

	// Small delay so the spinner feels purposeful
	await new Promise((r) => setTimeout(r, 600));

	s.stop("Environment scanned");

	// Build detection summary
	const detectionLines: string[] = [];

	const platformLabel = platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
	detectionLines.push(`Platform:     ${platformLabel}`);
	detectionLines.push("");
	detectionLines.push("Agent CLIs:");

	for (const cli of clis) {
		const icon = cli.found ? "  ✅" : "  ⬚ ";
		const status = cli.found ? "" : " (not found)";
		detectionLines.push(`${icon} ${cli.name}${status}`);
	}

	detectionLines.push("");
	detectionLines.push(
		`Meilisearch:  ${hasMeili ? "✅ running on :7700" : "⬚  not detected (will use file-based memory)"}`,
	);

	note(detectionLines.join("\n"), "🔍 Detection Results");

	return { platform, clis, hasMeili };
}

// ── QuickStart Flow ─────────────────────────────────────────────────────

async function quickStartFlow(env: EnvDetection): Promise<void> {
	log.info("⚡ QuickStart — smart defaults, minimal questions.\n");

	const foundClis = env.clis.filter((c) => c.found);
	const agentOptions =
		foundClis.length > 0
			? foundClis.map((c) => ({
					value: c.name,
					label: c.name,
					hint: "detected",
				}))
			: [
					{ value: "opencode", label: "opencode" },
					{ value: "claude-code", label: "claude-code" },
					{ value: "codex", label: "codex" },
				];

	const results = await group(
		{
			name: () =>
				text({
					message: "What should we call your agent?",
					placeholder: "my-agent",
					defaultValue: "my-agent",
					validate: (value) => {
						if (!value) return "Agent name is required";
						if (!/^[a-z0-9-]+$/.test(value))
							return "Use lowercase letters, numbers, and hyphens only";
					},
				}),
			workdir: () =>
				text({
					message: "Working directory for your agent?",
					placeholder: ".",
					defaultValue: ".",
				}),
			agent: () =>
				select({
					message: "Which agent CLI should Randal use?",
					options: agentOptions,
					initialValue: agentOptions[0].value,
				}),
		},
		{
			onCancel: () => {
				cancel("Operation cancelled. No files were written.");
				process.exit(0);
			},
		},
	);

	await writeConfig({
		name: results.name as string,
		workdir: results.workdir as string,
		agent: results.agent as string,
		useMeilisearch: env.hasMeili,
	});
}

// ── Advanced Wizard Flow ────────────────────────────────────────────────

async function advancedWizardFlow(env: EnvDetection): Promise<void> {
	log.info("🔧 Advanced Setup — full control over every section.\n");

	const foundClis = env.clis.filter((c) => c.found);
	const agentOptions =
		foundClis.length > 0
			? foundClis.map((c) => ({
					value: c.name,
					label: c.name,
					hint: "detected",
				}))
			: [
					{ value: "opencode", label: "opencode" },
					{ value: "claude-code", label: "claude-code" },
					{ value: "codex", label: "codex" },
				];

	// ── Identity ──

	note(
		"The agent's persona defines how it behaves.\nRules are constraints it must follow.",
		"🪪 Identity",
	);

	const identity = await group(
		{
			name: () =>
				text({
					message: "Agent name",
					placeholder: "my-agent",
					defaultValue: "my-agent",
					validate: (value) => {
						if (!value) return "Agent name is required";
						if (!/^[a-z0-9-]+$/.test(value))
							return "Use lowercase letters, numbers, and hyphens only";
					},
				}),
			persona: () =>
				text({
					message: "Agent persona (one-liner)",
					placeholder: "You are a senior engineer who writes clean, tested code.",
					defaultValue: "You are a helpful AI assistant.",
				}),
			useTypeScriptIdentity: () =>
				confirm({
					message: "Use a TypeScript module for identity? (instead of Markdown template)",
					initialValue: false,
				}),
		},
		{
			onCancel: () => {
				cancel("Operation cancelled. No files were written.");
				process.exit(0);
			},
		},
	);

	// ── Runner ──

	note(
		"Configure how the agent executes tasks.\nThe runner spawns the agent CLI and manages the execution loop.",
		"🎯 Runner",
	);

	const runner = await group(
		{
			agent: () =>
				select({
					message: "Agent CLI",
					options: agentOptions,
					initialValue: agentOptions[0].value,
				}),
			model: () =>
				text({
					message: "Default model",
					placeholder: "anthropic/claude-sonnet-4",
					defaultValue: "anthropic/claude-sonnet-4",
				}),
			workdir: () =>
				text({
					message: "Working directory",
					placeholder: ".",
					defaultValue: ".",
				}),
			maxIterations: () =>
				text({
					message: "Max iterations per job",
					placeholder: "20",
					defaultValue: "20",
					validate: (value) => {
						const n = Number.parseInt(value, 10);
						if (Number.isNaN(n) || n < 1) return "Must be a positive number";
					},
				}),
		},
		{
			onCancel: () => {
				cancel("Operation cancelled. No files were written.");
				process.exit(0);
			},
		},
	);

	// ── Claude Code Setup ──

	let anthropicApiKey = "";
	if (runner.agent === "claude-code") {
		const claudeInstalled = env.clis.find((c) => c.name === "claude-code")?.found ?? false;

		if (!claudeInstalled) {
			note(
				"Claude Code CLI is not installed. It's needed to run your agent.",
				"Claude Code Not Found",
			);

			const installClaude = await confirm({
				message: "Install Claude Code now?",
				initialValue: true,
			});
			handleCancel(installClaude);

			if (installClaude) {
				const cs = spinner();
				cs.start("Installing Claude Code (this may take a minute)...");
				const ok = await ensureClaudeCode();
				if (ok) {
					cs.stop("Claude Code installed");
				} else {
					cs.stop("Installation failed");
					log.warn("Install manually: npm i -g @anthropic-ai/claude-code");
				}
			}
		}

		note("Claude Code needs authentication to call the Anthropic API.", "Claude Code Auth");

		const authMethod = await select({
			message: "How would you like to authenticate?",
			options: [
				{ value: "api-key", label: "API Key", hint: "paste your Anthropic API key" },
				{ value: "oauth", label: "Max Plan (OAuth)", hint: "opens browser to sign in" },
				{ value: "skip", label: "Skip", hint: "configure later in .env" },
			],
			initialValue: "api-key",
		});
		handleCancel(authMethod);

		if (authMethod === "api-key") {
			const keyInput = await text({
				message: "Anthropic API key",
				placeholder: "sk-ant-...",
				validate: (value) => {
					if (!value.trim()) return "API key is required";
				},
			});
			handleCancel(keyInput);
			anthropicApiKey = (keyInput as string).trim();
		} else if (authMethod === "oauth") {
			note("Launching 'claude login' — follow the browser prompts to authenticate.", "OAuth");
			const proc = Bun.spawnSync(["claude", "login"], {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
				timeout: 120_000,
			});
			if (proc.exitCode === 0) {
				log.success("OAuth authentication complete");
			} else {
				log.warn("OAuth may not have completed. You can retry later with: claude login");
			}
		}
	}

	// ── Gateway ──

	note("The HTTP gateway exposes the API, SSE stream, and web dashboard.", "📡 Gateway");

	const gateway = await group(
		{
			port: () =>
				text({
					message: "HTTP port",
					placeholder: "7600",
					defaultValue: "7600",
					validate: (value) => {
						const n = Number.parseInt(value, 10);
						if (Number.isNaN(n) || n < 1 || n > 65535) return "Must be a valid port (1-65535)";
					},
				}),
		},
		{
			onCancel: () => {
				cancel("Operation cancelled. No files were written.");
				process.exit(0);
			},
		},
	);

	// ── Messaging Channels ──

	note(
		"Connect messaging channels for chat-based interaction.\nCommands: run, status, stop, context, jobs, memory, resume, help.\nOr just send a message to start a job.",
		"Messaging Channels",
	);

	const discordEnabled = await confirm({
		message: "Enable Discord channel?",
		initialValue: false,
	});
	handleCancel(discordEnabled);

	let discordAllowFrom: string[] = [];
	let discordToken = "";
	if (discordEnabled) {
		note(
			[
				"To connect Discord, you need a bot token:",
				"",
				"1. Go to https://discord.com/developers/applications",
				"2. Click 'New Application' → name it → click 'Bot' in sidebar",
				"3. Click 'Reset Token' → copy the token",
				"4. Under 'Privileged Gateway Intents', enable 'Message Content Intent'",
				"5. Go to OAuth2 → URL Generator → select 'bot' scope",
				"   Permissions: Send Messages, Read Message History, View Channels",
				"6. Open the generated URL to invite the bot to your server",
			].join("\n"),
			"Discord Bot Setup",
		);

		const tokenInput = await text({
			message: "Paste your Discord bot token",
			placeholder: "MTIz...abc",
			validate: (value) => {
				if (!value.trim()) return "Bot token is required to use Discord";
			},
		});
		handleCancel(tokenInput);
		discordToken = (tokenInput as string).trim();

		const allowFromInput = await text({
			message: "Discord user IDs to allow (comma-separated, or leave blank for all)",
			placeholder: "123456789012345678",
			defaultValue: "",
		});
		handleCancel(allowFromInput);
		if (typeof allowFromInput === "string" && allowFromInput.trim()) {
			discordAllowFrom = allowFromInput
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
	}

	let imessageEnabled = false;
	let imessageAllowFrom: string[] = [];
	let blueBubblesUrl = "";
	let blueBubblesPassword = "";
	if (process.platform === "darwin") {
		const imessageConfirm = await confirm({
			message: "Enable iMessage channel (via BlueBubbles)?",
			initialValue: false,
		});
		handleCancel(imessageConfirm);
		imessageEnabled = imessageConfirm as boolean;

		if (imessageEnabled) {
			// Auto-start Messages.app
			const ms = spinner();
			ms.start("Starting Messages.app...");
			startMessagesApp();
			await new Promise((r) => setTimeout(r, 2000));
			ms.stop("Messages.app started");

			note(
				[
					"BlueBubbles bridges iMessage to Randal via webhooks.",
					"",
					"If you haven't installed BlueBubbles yet:",
					"  1. Download from https://bluebubbles.app",
					"  2. Open BlueBubbles Server and sign into your Apple ID",
					"  3. In Settings → Webhooks, add:",
					`     http://localhost:${gateway.port ?? "7600"}/webhooks/imessage`,
				].join("\n"),
				"iMessage / BlueBubbles Setup",
			);

			const urlInput = await text({
				message: "BlueBubbles server URL",
				placeholder: "http://localhost:1234",
				defaultValue: "http://localhost:1234",
			});
			handleCancel(urlInput);
			blueBubblesUrl = (urlInput as string).trim();

			const passwordInput = await text({
				message: "BlueBubbles server password",
				placeholder: "your-bluebubbles-password",
				validate: (value) => {
					if (!value.trim()) return "BlueBubbles password is required";
				},
			});
			handleCancel(passwordInput);
			blueBubblesPassword = (passwordInput as string).trim();

			const allowFromInput = await text({
				message: "Phone numbers to allow (comma-separated, or leave blank for all)",
				placeholder: "+15551234567",
				defaultValue: "",
			});
			handleCancel(allowFromInput);
			if (typeof allowFromInput === "string" && allowFromInput.trim()) {
				imessageAllowFrom = allowFromInput
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
			}
		}
	}

	// ── Memory ──

	note(
		"Memory gives your agent persistent context across runs.\nMeilisearch enables full-text search and cross-agent sharing.",
		"🧠 Memory",
	);

	const memoryBackend = await select({
		message: "Memory backend",
		options: [
			{
				value: "file",
				label: "📄 File-based",
				hint: "Simple. Stores in MEMORY.md.",
			},
			{
				value: "meilisearch",
				label: "🔍 Meilisearch",
				hint: env.hasMeili
					? "detected on :7700 — full-text search + cross-agent sharing"
					: "not detected — we'll start it via Docker for you",
			},
		],
		initialValue: env.hasMeili ? "meilisearch" : "file",
	});
	handleCancel(memoryBackend);

	// ── Autonomy ──

	note(
		"Heartbeat wakes your agent on a schedule to check in.\nHooks let external events trigger jobs via webhooks.",
		"🤖 Autonomy",
	);

	const autonomy = await group(
		{
			heartbeatEnabled: () =>
				confirm({
					message: "Enable heartbeat? (periodic autonomous check-ins)",
					initialValue: false,
				}),
			heartbeatEvery: ({ results }) => {
				if (!results.heartbeatEnabled) return Promise.resolve("30m");
				return text({
					message: "Heartbeat interval",
					placeholder: "30m",
					defaultValue: "30m",
				});
			},
			hooksEnabled: () =>
				confirm({
					message: "Enable webhook hooks? (external event triggers)",
					initialValue: false,
				}),
		},
		{
			onCancel: () => {
				cancel("Operation cancelled. No files were written.");
				process.exit(0);
			},
		},
	);

	await writeConfig({
		name: identity.name as string,
		workdir: runner.workdir as string,
		agent: runner.agent as string,
		model: runner.model as string,
		persona: identity.persona as string,
		useMeilisearch: memoryBackend === "meilisearch",
		heartbeatEnabled: autonomy.heartbeatEnabled as boolean,
		heartbeatEvery: autonomy.heartbeatEvery as string,
		hooksEnabled: autonomy.hooksEnabled as boolean,
		port: Number.parseInt(gateway.port as string, 10),
		maxIterations: Number.parseInt(runner.maxIterations as string, 10),
		discordEnabled: discordEnabled as boolean,
		discordAllowFrom,
		discordToken,
		imessageEnabled,
		imessageAllowFrom,
		blueBubblesUrl,
		blueBubblesPassword,
		useTypeScriptIdentity: identity.useTypeScriptIdentity as boolean,
		anthropicApiKey,
	});
}

// ── Write Config ────────────────────────────────────────────────────────

async function writeConfig(opts: {
	name: string;
	workdir: string;
	agent: string;
	model?: string;
	persona?: string;
	useMeilisearch: boolean;
	heartbeatEnabled?: boolean;
	heartbeatEvery?: string;
	hooksEnabled?: boolean;
	port?: number;
	maxIterations?: number;
	discordEnabled?: boolean;
	discordAllowFrom?: string[];
	discordToken?: string;
	imessageEnabled?: boolean;
	imessageAllowFrom?: string[];
	blueBubblesUrl?: string;
	blueBubblesPassword?: string;
	useTypeScriptIdentity?: boolean;
	anthropicApiKey?: string;
}): Promise<void> {
	const s = spinner();
	s.start("Writing configuration...");

	const configYaml = buildConfigYaml(opts);

	writeFileSync(resolve("randal.config.yaml"), configYaml, "utf-8");

	// Write IDENTITY.md or identity.ts
	if (opts.useTypeScriptIdentity) {
		writeFileSync(resolve("identity.ts"), buildIdentityTsTemplate(opts.name), "utf-8");
	} else {
		writeFileSync(resolve("IDENTITY.md"), IDENTITY_MD_TEMPLATE, "utf-8");
	}

	// Write HEARTBEAT.md when heartbeat is enabled
	if (opts.heartbeatEnabled) {
		writeFileSync(resolve("HEARTBEAT.md"), HEARTBEAT_MD_TEMPLATE, "utf-8");
	}

	// Write .env template if it doesn't exist
	const envPath = resolve(".env");
	let envCreated = false;
	if (!existsSync(envPath)) {
		writeFileSync(
			envPath,
			generateEnvTemplate({
				discordEnabled: opts.discordEnabled,
				imessageEnabled: opts.imessageEnabled,
				anthropicApiKey: opts.anthropicApiKey,
				discordToken: opts.discordToken,
				blueBubblesUrl: opts.blueBubblesUrl,
				blueBubblesPassword: opts.blueBubblesPassword,
			}),
			"utf-8",
		);
		envCreated = true;
	} else {
		// .env already exists — append any new credentials the user provided
		const creds: Record<string, string> = {};
		if (opts.anthropicApiKey) creds.ANTHROPIC_API_KEY = opts.anthropicApiKey;
		if (opts.discordToken) creds.DISCORD_BOT_TOKEN = opts.discordToken;
		if (opts.blueBubblesUrl) creds.BLUEBUBBLES_URL = opts.blueBubblesUrl;
		if (opts.blueBubblesPassword) creds.BLUEBUBBLES_PASSWORD = opts.blueBubblesPassword;
		appendEnvValues(envPath, creds);
	}

	await new Promise((r) => setTimeout(r, 400));
	s.stop("Configuration written");

	// ── Post-setup: Meilisearch ──
	if (opts.useMeilisearch) {
		const ms = spinner();
		ms.start("Starting Meilisearch...");
		const result = await ensureMeilisearch();
		if (result.started) {
			ms.stop("Meilisearch running on :7700");
			if (result.apiKey) {
				appendEnvValues(envPath, { MEILI_MASTER_KEY: result.apiKey });
			}
		} else {
			ms.stop("Meilisearch could not be started");
			const dockerCheck = Bun.spawnSync(["which", "docker"]);
			if (dockerCheck.exitCode !== 0) {
				log.warn("Docker not found. Install Docker, then run:");
				log.warn("  docker run -d -p 7700:7700 getmeili/meilisearch:v1.12");
			} else {
				log.warn("Start manually: docker run -d -p 7700:7700 getmeili/meilisearch:v1.12");
			}
		}
	}

	// Summary
	const summaryLines = ["📄 randal.config.yaml"];
	if (opts.useTypeScriptIdentity) {
		summaryLines.push("📄 identity.ts");
	} else {
		summaryLines.push("📄 IDENTITY.md");
	}
	if (opts.heartbeatEnabled) {
		summaryLines.push("📄 HEARTBEAT.md");
	}
	if (envCreated) {
		summaryLines.push("📄 .env");
	}
	summaryLines.push("");
	summaryLines.push(`Agent:    ${opts.name}`);
	summaryLines.push(`CLI:      ${opts.agent}`);
	summaryLines.push(`Workdir:  ${opts.workdir}`);
	summaryLines.push(`Memory:   ${opts.useMeilisearch ? "Meilisearch" : "file-based"}`);
	if (opts.heartbeatEnabled) {
		summaryLines.push(`Heartbeat: every ${opts.heartbeatEvery ?? "30m"}`);
	}
	if (opts.port && opts.port !== 7600) {
		summaryLines.push(`Port:     ${opts.port}`);
	}
	if (opts.discordEnabled) {
		summaryLines.push("Discord:  enabled");
	}
	if (opts.imessageEnabled) {
		summaryLines.push("iMessage: enabled (BlueBubbles)");
	}

	note(summaryLines.join("\n"), "✅ Created");

	outro(
		`Saddle up! Run ${"randal serve"} to start your agent.\n   Dashboard: http://localhost:${opts.port ?? 7600}`,
	);
}

// ── Bootstrap from existing config ──────────────────────────────────────

async function initFrom(configPath: string): Promise<void> {
	intro("🤠 Randal — Bootstrap from Existing Config");

	if (!existsSync(configPath)) {
		cancel(`Config file not found: ${configPath}`);
		process.exit(1);
	}

	const s = spinner();
	s.start("Validating config...");

	const raw = readFileSync(configPath, "utf-8");
	const parsed = parseYaml(raw);
	const result = configSchema.safeParse(parsed);

	await new Promise((r) => setTimeout(r, 400));

	if (result.success) {
		s.stop("Config is valid");
		const sections = Object.keys(parsed);
		note(sections.map((k) => `  ✅ ${k}`).join("\n"), "📋 Sections Found");
	} else {
		s.stop("Config has issues");
		const issues = result.error.issues.map((i) => `  ⚠️  ${i.path.join(".")}: ${i.message}`);
		note(
			[...issues, "", "Missing fields will be filled with defaults."].join("\n"),
			"⚠️  Validation",
		);
	}

	// Merge with defaults
	const merged = configSchema.parse(parsed);
	const yamlOutput = stringifyYaml(merged, { indent: 2 });

	const outputPath = resolve("randal.config.yaml");
	if (existsSync(outputPath)) {
		const overwrite = await confirm({
			message: "randal.config.yaml already exists. Overwrite?",
			initialValue: false,
		});
		handleCancel(overwrite);
		if (!overwrite) {
			cancel("Aborted. No files were changed.");
			return;
		}
	}

	const ws = spinner();
	ws.start("Writing config...");
	writeFileSync(
		outputPath,
		`# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n# 🤠 Bootstrapped from ${configPath}\n# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${yamlOutput}`,
		"utf-8",
	);

	if (!existsSync(resolve(".env"))) {
		writeFileSync(resolve(".env"), generateEnvTemplate(), "utf-8");
	}
	await new Promise((r) => setTimeout(r, 300));
	ws.stop("Config written");

	outro(`Bootstrapped from ${configPath}. Ready to ride! 🤠`);
}

// ── Non-interactive mode ────────────────────────────────────────────────

function initNonInteractive(): void {
	console.log("🤠 Randal — Non-interactive Init\n");

	// Auto-detect agent CLI
	const clis = detectAgentCLIs();
	const foundCli = clis.find((c) => c.found);
	const agent = foundCli?.name ?? "opencode";

	console.log(`  Agent CLI: ${agent}${foundCli ? " (detected)" : " (default)"}`);

	const configYaml = buildConfigYaml({
		name: "randal-agent",
		workdir: ".",
		agent,
		useMeilisearch: false,
	});

	writeFileSync(resolve("randal.config.yaml"), configYaml, "utf-8");
	console.log("  ✅ Created randal.config.yaml");

	writeFileSync(resolve("IDENTITY.md"), IDENTITY_MD_TEMPLATE, "utf-8");
	console.log("  ✅ Created IDENTITY.md");

	if (!existsSync(resolve(".env"))) {
		writeFileSync(resolve(".env"), generateEnvTemplate(), "utf-8");
		console.log("  ✅ Created .env template");
	}

	console.log("\n  Run: randal serve");
}

// ── Entry point ─────────────────────────────────────────────────────────

export async function initCommand(args: string[]): Promise<void> {
	const outputPath = resolve("randal.config.yaml");

	// Parse flags
	const hasWizard = args.includes("--wizard");
	const hasYes = args.includes("--yes") || args.includes("--non-interactive");
	const fromIdx = args.indexOf("--from");
	const fromPath = fromIdx !== -1 ? args[fromIdx + 1] : undefined;

	// Non-interactive mode — no TUI at all
	if (hasYes) {
		initNonInteractive();
		return;
	}

	// Bootstrap from existing config
	if (fromPath) {
		await initFrom(fromPath);
		return;
	}

	// ── Interactive modes (default + wizard) ──

	intro(BANNER);

	// Check for existing config
	if (existsSync(outputPath)) {
		const overwrite = await confirm({
			message: "randal.config.yaml already exists. Overwrite?",
			initialValue: false,
		});
		handleCancel(overwrite);
		if (!overwrite) {
			cancel("Aborted. No files were changed.");
			return;
		}
	}

	// Detect environment
	const env = await detectEnvironment();

	// Choose setup mode
	if (hasWizard) {
		await advancedWizardFlow(env);
	} else {
		const mode = await select({
			message: "How would you like to set up?",
			options: [
				{
					value: "quickstart",
					label: "⚡ QuickStart",
					hint: "auto-detect, smart defaults — 3 questions",
				},
				{
					value: "advanced",
					label: "🔧 Advanced",
					hint: "full control — identity, runner, memory, autonomy",
				},
			],
			initialValue: "quickstart",
		});
		handleCancel(mode);

		if (mode === "quickstart") {
			await quickStartFlow(env);
		} else {
			await advancedWizardFlow(env);
		}
	}
}
