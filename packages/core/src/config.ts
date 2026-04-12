import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type ZodError, z } from "zod";

// ---- Sub-schemas ----

const httpChannelSchema = z.object({
	type: z.literal("http"),
	port: z.number().default(7600),
	auth: z.string(),
	corsOrigin: z.string().optional(),
});

const discordCommandOptionSchema = z.object({
	name: z.string(),
	description: z.string(),
	type: z.enum(["string", "integer", "boolean", "number"]).default("string"),
	required: z.boolean().default(false),
	choices: z.array(z.string()).optional(),
});

const discordCustomCommandSchema = z.object({
	name: z.string(),
	description: z.string(),
	options: z.array(discordCommandOptionSchema).default([]),
});

const discordServerSchema = z.object({
	guildId: z.string(),
	agent: z.string().optional(),
	model: z.string().optional(),
	instructions: z.string().optional(),
	commands: z.array(discordCustomCommandSchema).default([]),
});

const discordChannelSchema = z.object({
	type: z.literal("discord"),
	token: z.string(),
	allowFrom: z.array(z.string()).optional(),
	/** Guild ID for instant slash command registration. If omitted, uses global (slow propagation). */
	guildId: z.string().optional(),
	/** Per-server configuration with custom commands, agent overrides, and instructions. */
	servers: z.array(discordServerSchema).default([]),
});

const imessageChannelSchema = z.object({
	type: z.literal("imessage"),
	provider: z.literal("bluebubbles"),
	url: z.string(),
	password: z.string(),
	allowFrom: z.array(z.string()).optional(),
	webhookSecret: z.string().optional(),
});

const telegramChannelSchema = z.object({
	type: z.literal("telegram"),
	token: z.string(),
	allowFrom: z.array(z.string()).optional(),
});

const slackChannelSchema = z.object({
	type: z.literal("slack"),
	botToken: z.string(),
	appToken: z.string(),
	signingSecret: z.string().optional(),
	allowFrom: z.array(z.string()).optional(),
});

const emailChannelSchema = z.object({
	type: z.literal("email"),
	imap: z.object({
		host: z.string(),
		port: z.number().default(993),
		user: z.string(),
		password: z.string(),
		tls: z.boolean().default(true),
	}),
	smtp: z.object({
		host: z.string(),
		port: z.number().default(587),
		user: z.string(),
		password: z.string(),
		secure: z.boolean().default(false),
	}),
	allowFrom: z.array(z.string()).optional(),
});

const whatsappChannelSchema = z.object({
	type: z.literal("whatsapp"),
	provider: z.enum(["twilio"]).default("twilio"),
	accountSid: z.string().optional(),
	authToken: z.string().optional(),
	phoneNumber: z.string().optional(),
	webhookUrl: z.string().optional(),
	allowFrom: z.array(z.string()).optional(),
});

const signalChannelSchema = z.object({
	type: z.literal("signal"),
	phoneNumber: z.string(),
	signalCliBin: z.string().default("signal-cli"),
	allowFrom: z.array(z.string()).optional(),
});

const voiceChannelSchema = z.object({
	type: z.literal("voice"),
	allowFrom: z.array(z.string()).optional(),
});

const channelSchema = z.discriminatedUnion("type", [
	httpChannelSchema,
	discordChannelSchema,
	imessageChannelSchema,
	telegramChannelSchema,
	slackChannelSchema,
	emailChannelSchema,
	whatsappChannelSchema,
	signalChannelSchema,
	voiceChannelSchema,
]);

const builtinEmbedderSchema = z.object({ type: z.literal("builtin") });
const openaiEmbedderSchema = z.object({
	type: z.literal("openai"),
	model: z.string().default("text-embedding-3-large"),
	apiKey: z.string(),
});
const openrouterEmbedderSchema = z.object({
	type: z.literal("openrouter"),
	model: z.string(),
	apiKey: z.string(),
	url: z.string().default("https://openrouter.ai/api/v1/embeddings"),
});
const ollamaEmbedderSchema = z.object({
	type: z.literal("ollama"),
	model: z.string(),
	url: z.string().default("http://localhost:11434"),
});

/**
 * Embedder configuration for memory search.
 *
 * Currently only "openrouter" is fully wired to Meilisearch's REST embedder.
 * Other types fall back to keyword-only search:
 * - "builtin": Uses Meilisearch's built-in embedder (requires Meilisearch
 *   configured with an embedding model — not currently set up in auto-start).
 * - "openai": Schema accepted but not yet wired to MeilisearchStore.
 * - "ollama": Schema accepted but not yet wired to MeilisearchStore.
 *
 * See memory.ts:resolveEmbedderConfig() for the mapping.
 */
const embedderSchema = z.discriminatedUnion("type", [
	builtinEmbedderSchema,
	openaiEmbedderSchema,
	openrouterEmbedderSchema,
	ollamaEmbedderSchema,
]);

const toolSchema = z.object({
	name: z.string(),
	binary: z.string(),
	skill: z.string().optional(),
	platforms: z.array(z.enum(["darwin", "linux", "win32"])).default(["darwin", "linux"]),
});

// ---- Service credential schemas ----

const envCredentialSchema = z.object({
	type: z.literal("env"),
	vars: z.record(z.string()).default({}),
});

const fileCredentialSchema = z.object({
	type: z.literal("file"),
	file: z.string(),
	mountAs: z.string(),
	vars: z.record(z.string()).default({}),
});

const ambientCredentialSchema = z.object({
	type: z.literal("ambient"),
	binaries: z.array(z.string()).default([]),
	paths: z.array(z.string()).default([]),
});

const scriptCredentialSchema = z.object({
	type: z.literal("script"),
	command: z.string(),
	vars: z.record(z.string()).default({}),
	ttl: z.number().optional(),
});

const noneCredentialSchema = z.object({
	type: z.literal("none"),
	binaries: z.array(z.string()).default([]),
	vars: z.array(z.string()).default([]),
});

const serviceCredentialSchema = z.discriminatedUnion("type", [
	envCredentialSchema,
	fileCredentialSchema,
	ambientCredentialSchema,
	scriptCredentialSchema,
	noneCredentialSchema,
]);

const serviceSchema = z.object({
	description: z.string().optional(),
	credentials: serviceCredentialSchema,
	audit: z.boolean().default(false),
});

// ---- Sandbox schema ----

const sandboxSchema = z
	.object({
		enforcement: z.enum(["none", "env-scrub"]).default("none"),
		pathFilter: z
			.object({
				mode: z.enum(["inherit", "allowlist", "blocklist"]).default("inherit"),
				allow: z.array(z.string()).default([]),
				block: z.array(z.string()).default([]),
			})
			.default({}),
		homeAccess: z
			.object({
				ssh: z.boolean().default(true),
				gitconfig: z.boolean().default(true),
				docker: z.boolean().default(true),
				aws: z.boolean().default(true),
			})
			.default({}),
	})
	.default({});

// ---- Updates schema ----

const updatesSchema = z
	.object({
		autoCheck: z.boolean().default(false),
		autoApply: z.boolean().default(false),
		autoRestart: z.boolean().default(false),
		channel: z.enum(["stable", "main"]).default("main"),
		interval: z.string().nullable().default("6h"),
		notify: z.boolean().default(true),
	})
	.default({});

// ---- Main config schema ----

export const configSchema = z.object({
	name: z.string(),
	version: z.string().default("0.1"),
	posse: z.string().optional(),

	identity: z
		.object({
			persona: z.string().optional(),
			systemPrompt: z.string().optional(),
			knowledge: z.array(z.string()).default([]),
			rules: z.array(z.string()).default([]),
			vars: z.record(z.string()).default({}),
		})
		.default({}),

	runner: z.object({
		defaultAgent: z.enum(["opencode", "mock"]).default("opencode"),
		defaultModel: z.string().default("anthropic/claude-sonnet-4"),
		defaultMaxIterations: z.number().default(20),
		workdir: z.string(),
		allowedWorkdirs: z.array(z.string()).optional(),
		completionPromise: z.string().default("DONE"),
		iterationTimeout: z.number().positive().default(600),
		maxDelegationDepth: z.number().default(2),
		maxDelegationsPerIteration: z.number().default(3),
		agentName: z.string().optional(),
		sessionTimeout: z.number().positive().default(3600),
		struggle: z
			.object({
				noChangeThreshold: z.number().default(3),
				maxRepeatedErrors: z.number().default(3),
				action: z.enum(["warn", "stop"]).default("warn"),
			})
			.default({}),
		mcpServer: z
			.object({
				enabled: z.boolean().default(false),
				port: z.number().default(7601),
				tools: z
					.array(z.string())
					.default(["memory_search", "context", "status", "skills", "annotate"]),
			})
			.default({}),
		compaction: z
			.object({
				enabled: z.boolean().default(false),
				threshold: z.number().min(0).max(1).default(0.8),
				/** Reserved for future LLM-based compaction. Not used by the current rule-based implementation. */
				model: z.string().default("anthropic/claude-haiku-3"),
				maxSummaryTokens: z.number().default(2000),
			})
			.default({}),
	}),

	credentials: z
		.object({
			envFile: z.string().default("./.env"),
			allow: z.array(z.string()).default([]),
			inherit: z.array(z.string()).default(["PATH", "HOME", "USER", "SHELL", "TERM"]),
		})
		.default({}),

	services: z.record(serviceSchema).default({}),

	sandbox: sandboxSchema,

	updates: updatesSchema,

	gateway: z
		.object({
			channels: z.array(channelSchema).default([]),
		})
		.default({}),

	memory: z
		.object({
			store: z.literal("meilisearch").default("meilisearch"),
			url: z.string().default("http://localhost:7700"),
			apiKey: z.string().default(""),
			index: z.string().optional(),
			embedder: embedderSchema.default({ type: "builtin" }),
			semanticRatio: z.number().min(0).max(1).default(0.7),
			sharing: z
				.object({
					publishTo: z.string().optional(),
					readFrom: z.array(z.string()).default([]),
				})
				.default({}),
			autoInject: z
				.object({
					enabled: z.boolean().default(true),
					maxResults: z.number().default(5),
				})
				.default({}),
		})
		.default({}),

	tools: z.array(toolSchema).default([]),

	capabilities: z.array(z.string()).default([]),

	skills: z
		.object({
			dir: z.string().default("./skills"),
			autoDiscover: z.boolean().default(true),
			maxPerPrompt: z.number().default(5),
			index: z.string().optional(),
			sharing: z
				.object({
					publishTo: z.string().optional(),
					readFrom: z.array(z.string()).default([]),
				})
				.default({}),
		})
		.default({}),

	heartbeat: z
		.object({
			enabled: z.boolean().default(false),
			every: z.string().default("30m"),
			prompt: z.string().default("./HEARTBEAT.md"),
			activeHours: z
				.object({
					start: z.string().optional(),
					end: z.string().optional(),
					timezone: z.string().default("UTC"),
				})
				.default({}),
			target: z.string().default("none"),
			model: z.string().optional(),
		})
		.default({}),

	cron: z
		.object({
			jobs: z
				.record(
					z.object({
						schedule: z.union([
							z.string(),
							z.object({ every: z.string() }),
							z.object({ at: z.string() }),
						]),
						prompt: z.string(),
						execution: z.enum(["main", "isolated"]).default("isolated"),
						model: z.string().optional(),
						announce: z.boolean().default(false),
					}),
				)
				.default({}),
		})
		.default({}),

	hooks: z
		.object({
			enabled: z.boolean().default(false),
			token: z.string().optional(),
			path: z.string().default("/hooks"),
		})
		.default({}),

	tracking: z
		.object({
			tokenPricing: z
				.record(
					z.object({
						input: z.number(),
						output: z.number(),
					}),
				)
				.default({}),
		})
		.default({}),

	voice: z
		.object({
			enabled: z.boolean().default(false),
			livekit: z
				.object({
					url: z.string().default(""),
					apiKey: z.string().default(""),
					apiSecret: z.string().default(""),
				})
				.default({}),
			twilio: z
				.object({
					accountSid: z.string().default(""),
					authToken: z.string().default(""),
					phoneNumber: z.string().default(""),
				})
				.default({}),
			stt: z
				.object({
					provider: z.enum(["deepgram", "whisper", "assemblyai"]).default("deepgram"),
					model: z.string().optional(),
					apiKey: z.string().default(""),
				})
				.default({}),
			tts: z
				.object({
					provider: z.enum(["elevenlabs", "cartesia", "openai", "edge"]).default("elevenlabs"),
					voice: z.string().optional(),
					apiKey: z.string().default(""),
				})
				.default({}),
			turnDetection: z
				.object({
					mode: z.enum(["auto", "manual"]).default("auto"),
				})
				.default({}),
			video: z
				.object({
					enabled: z.boolean().default(false),
					visionModel: z.string().default("gpt-4o"),
					publishScreen: z.boolean().default(false),
					recordSessions: z.boolean().default(false),
					recordPath: z.string().default("./recordings"),
				})
				.default({}),
		})
		.default({}),

	mesh: z
		.object({
			enabled: z.boolean().default(false),
			specialization: z.string().optional(),
			endpoint: z.string().optional(),
			routingWeights: z
				.object({
					specialization: z.number().default(0.4),
					reliability: z.number().default(0.3),
					load: z.number().default(0.2),
					modelMatch: z.number().default(0.1),
				})
				.default({}),
		})
		.default({}),

	analytics: z
		.object({
			enabled: z.boolean().default(false),
			autoAnnotationPrompt: z.boolean().default(true),
			feedbackInjection: z.boolean().default(true),
			recommendationFrequency: z.enum(["daily", "weekly", "on-demand"]).default("on-demand"),
			domainKeywords: z.record(z.array(z.string())).default({
				"product-engineering": [
					"react",
					"vue",
					"angular",
					"css",
					"html",
					"component",
					"api",
					"server",
					"endpoint",
					"rest",
					"graphql",
					"middleware",
					"sql",
					"migration",
					"schema",
					"postgres",
					"prisma",
					"typescript",
					"test",
					"spec",
					"jest",
					"vitest",
				],
				"platform-infrastructure": [
					"docker",
					"kubernetes",
					"ci",
					"cd",
					"deploy",
					"terraform",
					"aws",
					"gcp",
					"azure",
					"nginx",
					"monitoring",
					"k8s",
				],
				"security-compliance": [
					"security",
					"vulnerability",
					"audit",
					"compliance",
					"gdpr",
					"owasp",
					"encryption",
				],
				"data-intelligence": [
					"analytics",
					"ml",
					"machine learning",
					"etl",
					"warehouse",
					"dashboard",
					"bi",
				],
				"design-experience": ["design", "ux", "ui", "figma", "accessibility", "a11y", "i18n"],
				"content-communications": [
					"readme",
					"documentation",
					"docs",
					"guide",
					"tutorial",
					"changelog",
					"blog",
					"marketing",
				],
				"revenue-growth": ["sales", "revenue", "pricing", "conversion", "growth", "gtm"],
				"customer-operations": ["support", "ticket", "customer", "onboarding", "churn", "zendesk"],
				"strategy-finance": ["roadmap", "okr", "budget", "sprint", "finance", "strategy"],
				"legal-governance": ["contract", "legal", "policy", "license", "nda", "governance"],
			}),
			agingHalfLife: z.number().default(30),
		})
		.default({}),

	browser: z
		.object({
			enabled: z.boolean().default(false),
			headless: z.boolean().default(true),
			profileDir: z.string().optional(),
			sandbox: z.boolean().default(false),
			viewport: z
				.object({
					width: z.number().default(1280),
					height: z.number().default(720),
				})
				.default({}),
			timeout: z.number().default(30000),
		})
		.default({}),
});

export type RandalConfig = z.infer<typeof configSchema>;

// ---- Environment variable substitution ----

/**
 * Recursively substitute ${VAR} patterns with environment variable values.
 */
export function substituteEnvVars(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
			return process.env[varName] ?? "";
		});
	}
	if (Array.isArray(value)) {
		return value.map(substituteEnvVars);
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = substituteEnvVars(v);
		}
		return result;
	}
	return value;
}

// ---- Deep freeze ----

function deepFreeze<T extends object>(obj: T): T {
	Object.freeze(obj);
	for (const value of Object.values(obj)) {
		if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
			deepFreeze(value as object);
		}
	}
	return obj;
}

// ---- Zod error formatting ----

/**
 * Format a ZodError into a human-readable multi-line string.
 *
 * Instead of dumping raw JSON issues, produces output like:
 *   Config validation failed:
 *     - runner.workdir: Required (expected string, got undefined)
 *     - runner.defaultAgent: Invalid enum value (valid: opencode, mock)
 */
export function formatZodError(err: ZodError): string {
	const lines = err.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		let msg = `  - ${path}: ${issue.message}`;
		if (issue.code === "invalid_enum_value") {
			msg += ` (valid: ${(issue as { options: unknown[] }).options.join(", ")})`;
		}
		if (issue.code === "invalid_type") {
			const typed = issue as { expected: string; received: string };
			msg += ` (expected ${typed.expected}, got ${typed.received})`;
		}
		return msg;
	});
	return `Config validation failed:\n${lines.join("\n")}`;
}

// ---- Config resolution paths ----

const CONFIG_FILENAMES = ["randal.config.yaml", "randal.config.yml", "randal.yaml"];

/**
 * Find config file path. Checks explicit path first, then searches
 * current directory for known config filenames.
 */
export function findConfigPath(explicitPath?: string): string | null {
	if (explicitPath) {
		return resolve(explicitPath);
	}
	for (const name of CONFIG_FILENAMES) {
		const path = resolve(name);
		try {
			readFileSync(path);
			return path;
		} catch {
			// File doesn't exist, try next
		}
	}
	return null;
}

/**
 * Load config from a specific file path.
 */
function loadConfigFromFile(filePath: string): RandalConfig {
	const raw = readFileSync(filePath, "utf-8");
	const parsed = parseYaml(raw);
	const substituted = substituteEnvVars(parsed);
	const result = configSchema.safeParse(substituted);
	if (!result.success) {
		throw new Error(formatZodError(result.error));
	}
	return deepFreeze(result.data) as RandalConfig;
}

/**
 * Load and validate a Randal config.
 * Resolution order:
 *   1. Explicit path argument
 *   2. RANDAL_CONFIG_PATH environment variable
 *   3. RANDAL_CONFIG_YAML environment variable (inline YAML)
 *   4. Search current directory for config files
 *
 * Returns a deeply frozen, immutable config object.
 */
export function loadConfig(pathOrExplicit?: string): RandalConfig {
	// 1. Explicit path argument
	if (pathOrExplicit) {
		return loadConfigFromFile(resolve(pathOrExplicit));
	}

	// 2. RANDAL_CONFIG_PATH env var
	const envPath = process.env.RANDAL_CONFIG_PATH;
	if (envPath) {
		return loadConfigFromFile(resolve(envPath));
	}

	// 3. RANDAL_CONFIG_YAML env var (inline YAML)
	const envYaml = process.env.RANDAL_CONFIG_YAML;
	if (envYaml) {
		return parseConfig(envYaml);
	}

	// 4. Search current directory for config files
	const configPath = findConfigPath();
	if (configPath) {
		return loadConfigFromFile(configPath);
	}

	throw new Error(
		"No randal config found. Options:\n" +
			"  1. Run `randal init` to create randal.config.yaml\n" +
			"  2. Specify --config <path>\n" +
			"  3. Set RANDAL_CONFIG_PATH environment variable\n" +
			"  4. Set RANDAL_CONFIG_YAML environment variable with inline YAML",
	);
}

/**
 * Parse and validate config from a raw YAML string.
 * Returns a deeply frozen, immutable config object.
 */
export function parseConfig(yamlContent: string): RandalConfig {
	const parsed = parseYaml(yamlContent);
	const substituted = substituteEnvVars(parsed);
	const result = configSchema.safeParse(substituted);
	if (!result.success) {
		throw new Error(formatZodError(result.error));
	}
	return deepFreeze(result.data) as RandalConfig;
}

// ---- Config validation and merging ----

export interface ConfigValidation {
	valid: boolean;
	validFields: string[];
	missingFields: string[];
	warnings: string[];
	errors: string[];
}

/**
 * Deep merge a partial config with defaults.
 * Used for bootstrap scenarios where users provide incomplete configs.
 */
export function mergePartialConfig(partial: Record<string, unknown>): RandalConfig {
	const substituted = substituteEnvVars(partial);
	const result = configSchema.safeParse(substituted);
	if (!result.success) {
		throw new Error(formatZodError(result.error));
	}
	return deepFreeze(result.data) as RandalConfig;
}

/**
 * Validate a partial config and report what's present, what's missing,
 * and what needs attention. Used by `randal init --from`.
 */
export function validatePartialConfig(yamlContent: string): ConfigValidation {
	const parsed = parseYaml(yamlContent) as Record<string, unknown>;
	const result = configSchema.safeParse(substituteEnvVars(parsed));

	if (result.success) {
		return {
			valid: true,
			validFields: Object.keys(parsed),
			missingFields: [],
			warnings: [],
			errors: [],
		};
	}

	return {
		valid: false,
		validFields: Object.keys(parsed).filter(
			(k) => !result.error.issues.some((i) => i.path[0] === k),
		),
		missingFields: result.error.issues
			.filter((i) => i.code === "invalid_type" && i.received === "undefined")
			.map((i) => i.path.join(".")),
		warnings: [],
		errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
	};
}
