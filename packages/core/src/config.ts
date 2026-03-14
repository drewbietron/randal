import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---- Sub-schemas ----

const httpChannelSchema = z.object({
	type: z.literal("http"),
	port: z.number().default(7600),
	auth: z.string(),
});

const discordChannelSchema = z.object({
	type: z.literal("discord"),
	token: z.string(),
	allowFrom: z.array(z.string()).optional(),
});

const imessageChannelSchema = z.object({
	type: z.literal("imessage"),
	provider: z.literal("bluebubbles"),
	url: z.string(),
	password: z.string(),
	allowFrom: z.array(z.string()).optional(),
});

const channelSchema = z.discriminatedUnion("type", [
	httpChannelSchema,
	discordChannelSchema,
	imessageChannelSchema,
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
});
const ollamaEmbedderSchema = z.object({
	type: z.literal("ollama"),
	model: z.string(),
	url: z.string().default("http://localhost:11434"),
});

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
		})
		.default({}),

	runner: z.object({
		defaultAgent: z.enum(["opencode", "claude-code", "codex", "mock"]).default("opencode"),
		defaultModel: z.string().default("anthropic/claude-sonnet-4"),
		defaultMaxIterations: z.number().default(20),
		workdir: z.string(),
		allowedWorkdirs: z.array(z.string()).optional(),
		completionPromise: z.string().default("DONE"),
		struggle: z
			.object({
				noChangeThreshold: z.number().default(3),
				maxRepeatedErrors: z.number().default(3),
			})
			.default({}),
	}),

	credentials: z
		.object({
			envFile: z.string().default("./.env"),
			allow: z.array(z.string()).default([]),
			inherit: z.array(z.string()).default(["PATH", "HOME", "SHELL", "TERM"]),
		})
		.default({}),

	gateway: z
		.object({
			channels: z.array(channelSchema).default([]),
		})
		.default({}),

	memory: z
		.object({
			store: z.enum(["meilisearch", "file"]).default("meilisearch"),
			url: z.string().default("http://localhost:7700"),
			apiKey: z.string().default(""),
			index: z.string().optional(),
			syncInterval: z.number().default(60),
			files: z.array(z.string()).default(["MEMORY.md"]),
			embedder: embedderSchema.default({ type: "builtin" }),
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
	const validated = configSchema.parse(substituted);
	return deepFreeze(validated) as RandalConfig;
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
	const validated = configSchema.parse(substituted);

	return deepFreeze(validated) as RandalConfig;
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
	return deepFreeze(configSchema.parse(substituted)) as RandalConfig;
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
