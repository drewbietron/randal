/**
 * Posse Conductor Configuration System
 *
 * Handles loading, validation, and environment variable substitution
 * for the Conductor gateway configuration.
 *
 * Deployment-agnostic design works on both Mac Mini (local) and Railway (cloud).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type ZodError, z } from 'zod';
import { substituteEnvVars as coreSubstituteEnvVars } from '@randal/core';

// ============================================================================
// Schema Definitions
// ============================================================================

/** Server configuration schema */
const serverSchema = z.object({
	port: z.number().default(7777),
	host: z.string().default('0.0.0.0'),
});

/** HTTP gateway configuration schema */
const httpGatewaySchema = z.object({
	enabled: z.boolean().default(true),
	auth: z.string().optional(),
});

/** Discord gateway configuration schema */
const discordGatewaySchema = z.object({
	enabled: z.boolean().default(false),
	token: z.string().optional(),
	guildId: z.string().optional(),
});

/** Gateway configuration schema (HTTP + Discord) */
const gatewaySchema = z.object({
	http: httpGatewaySchema.default({}),
	discord: discordGatewaySchema.default({}),
});

/** Single agent configuration schema */
const singleAgentSchema = z.object({
	name: z.string(),
	url: z.string().url(),
	model: z.string().default('moonshotai/kimi-k2.5'),
});

/** Meilisearch configuration for posse mode */
const meilisearchSchema = z.object({
	url: z.string().url().default('http://localhost:7700'),
	apiKey: z.string().default(''),
});

/** Discovery configuration for posse mode */
const discoverySchema = z.object({
	enabled: z.boolean().default(true),
	pollInterval: z.number().default(30000),
});

/** Posse configuration schema */
const posseSchema = z.object({
	name: z.string(),
	meilisearch: meilisearchSchema.default({}),
	discovery: discoverySchema.default({}),
});

/** Routing strategy enum */
const routingStrategySchema = z.enum(['auto', 'round-robin', 'explicit']);

/** Routing configuration schema */
const routingSchema = z.object({
	strategy: routingStrategySchema.default('auto'),
});

/** Main Conductor configuration schema */
export const conductorConfigSchema = z.object({
	mode: z.enum(['single', 'posse']).default('single'),
	model: z.string().default('moonshotai/kimi-k2.5'),
	server: serverSchema.default({}),
	gateway: gatewaySchema.default({}),
	// Single mode: requires agent field
	agent: singleAgentSchema.optional(),
	// Posse mode: requires posse field
	posse: posseSchema.optional(),
	routing: routingSchema.default({}),
});

/** Inferred TypeScript type from the Zod schema */
export type ConductorConfig = z.infer<typeof conductorConfigSchema>;

/** Configuration validation result */
export interface ConfigValidation {
	valid: boolean;
	validFields: string[];
	missingFields: string[];
	warnings: string[];
	errors: string[];
}

// ============================================================================
// Environment Variable Substitution
// ============================================================================

/**
 * Recursively substitute ${VAR} patterns with environment variable values.
 * Re-exports from @randal/core for consistency.
 */
export function resolveEnvVars(value: unknown): unknown {
	return coreSubstituteEnvVars(value);
}

// ============================================================================
// Error Formatting
// ============================================================================

/**
 * Format a ZodError into a human-readable multi-line string.
 *
 * Produces output like:
 *   Config validation failed:
 *     - server.port: Expected number, received string
 *     - mode: Invalid enum value (valid: single, posse)
 */
function formatZodError(err: ZodError): string {
	const lines = err.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
		let msg = `  - ${path}: ${issue.message}`;
		if (issue.code === 'invalid_enum_value') {
			msg += ` (valid: ${(issue as { options: unknown[] }).options.join(', ')})`;
		}
		if (issue.code === 'invalid_type') {
			const typed = issue as { expected: string; received: string };
			msg += ` (expected ${typed.expected}, got ${typed.received})`;
		}
		return msg;
	});
	return `Config validation failed:\n${lines.join('\n')}`;
}

// ============================================================================
// Deep Freeze
// ============================================================================

function deepFreeze<T extends object>(obj: T): T {
	Object.freeze(obj);
	for (const value of Object.values(obj)) {
		if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
			deepFreeze(value as object);
		}
	}
	return obj;
}

// ============================================================================
// Config File Resolution
// ============================================================================

const CONFIG_FILENAMES = [
	'conductor.config.yaml',
	'conductor.config.yml',
	'conductor.yaml',
];

/**
 * Find config file path. Checks explicit path first, then searches
 * current directory for known config filenames.
 */
function findConfigPath(explicitPath?: string): string | null {
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

// ============================================================================
// Config Loading and Validation
// ============================================================================

/**
 * Validate configuration with mode-specific requirements.
 * Adds semantic validation beyond Zod schema checks.
 */
export function validateConfig(config: unknown): ConductorConfig {
	const parseResult = conductorConfigSchema.safeParse(config);

	if (!parseResult.success) {
		throw new Error(formatZodError(parseResult.error));
	}

	const validated = parseResult.data;

	// Mode-specific validation
	if (validated.mode === 'single') {
		if (!validated.agent) {
			throw new Error(
				'Config validation failed:\n' +
				'  - agent: Required when mode is "single" (expected object, got undefined)\n' +
				'    Must specify: agent.name, agent.url, agent.model (optional)'
			);
		}
	} else if (validated.mode === 'posse') {
		if (!validated.posse) {
			throw new Error(
				'Config validation failed:\n' +
				'  - posse: Required when mode is "posse" (expected object, got undefined)\n' +
				'    Must specify: posse.name, posse.meilisearch.url, posse.meilisearch.apiKey (optional)'
			);
		}
	}

	// Warning: Discord enabled but no token
	if (validated.gateway.discord.enabled && !validated.gateway.discord.token) {
		console.warn(
			'Warning: Discord gateway is enabled but no token is configured. ' +
			'Set gateway.discord.token or CONDUCTOR_DISCORD_TOKEN env var.'
		);
	}

	return deepFreeze(validated) as ConductorConfig;
}

/**
 * Load and parse config from a file path.
 */
function loadConfigFromFile(filePath: string): ConductorConfig {
	const raw = readFileSync(filePath, 'utf-8');
	const parsed = parseYaml(raw);
	const substituted = resolveEnvVars(parsed);
	return validateConfig(substituted);
}

/**
 * Load and validate a Conductor configuration.
 *
 * Resolution order:
 *   1. Explicit path argument
 *   2. CONDUCTOR_CONFIG_PATH environment variable
 *   3. CONDUCTOR_CONFIG_YAML environment variable (inline YAML)
 *   4. Search current directory for config files
 *
 * Returns a deeply frozen, immutable config object.
 */
export function loadConfig(pathOrExplicit?: string): ConductorConfig {
	// 1. Explicit path argument
	if (pathOrExplicit) {
		const config = loadConfigFromFile(resolve(pathOrExplicit));
		return deepFreeze(config) as ConductorConfig;
	}

	// 2. CONDUCTOR_CONFIG_PATH env var
	const envPath = process.env.CONDUCTOR_CONFIG_PATH;
	if (envPath) {
		const config = loadConfigFromFile(resolve(envPath));
		return deepFreeze(config) as ConductorConfig;
	}

	// 3. CONDUCTOR_CONFIG_YAML env var (inline YAML)
	const envYaml = process.env.CONDUCTOR_CONFIG_YAML;
	if (envYaml) {
		const parsed = parseYaml(envYaml);
		const substituted = resolveEnvVars(parsed);
		const config = validateConfig(substituted);
		return deepFreeze(config) as ConductorConfig;
	}

	// 4. Search current directory for config files
	const configPath = findConfigPath();
	if (configPath) {
		const config = loadConfigFromFile(configPath);
		return deepFreeze(config) as ConductorConfig;
	}

	throw new Error(
		'No conductor config found. Options:\n' +
		'  1. Create conductor.config.yaml in current directory\n' +
		'  2. Specify path: loadConfig("/path/to/config.yaml")\n' +
		'  3. Set CONDUCTOR_CONFIG_PATH environment variable\n' +
		'  4. Set CONDUCTOR_CONFIG_YAML environment variable with inline YAML'
	);
}

/**
 * Parse and validate config from a raw YAML string.
 * Returns a deeply frozen, immutable config object.
 */
export function parseConfig(yamlContent: string): ConductorConfig {
	const parsed = parseYaml(yamlContent);
	const substituted = resolveEnvVars(parsed);
	const config = validateConfig(substituted);
	return deepFreeze(config) as ConductorConfig;
}

/**
 * Validate a partial config and report what's present, what's missing,
 * and what needs attention.
 */
export function validatePartialConfig(yamlContent: string): ConfigValidation {
	let parsed: Record<string, unknown>;
	try {
		parsed = parseYaml(yamlContent) as Record<string, unknown>;
	} catch (err) {
		return {
			valid: false,
			validFields: [],
			missingFields: [],
			warnings: [],
			errors: [`YAML parse error: ${(err as Error).message}`],
		};
	}

	const substituted = resolveEnvVars(parsed);
	const result = conductorConfigSchema.safeParse(substituted);

	if (result.success) {
	if (result.success) {
		const warnings: string[] = [];
		const errors: string[] = [];

		// Check mode-specific requirements (treat as errors)
		if (result.data.mode === 'single' && !result.data.agent) {
			errors.push('Mode is "single" but no agent configuration provided');
		}
		if (result.data.mode === 'posse' && !result.data.posse) {
			errors.push('Mode is "posse" but no posse configuration provided');
		}
		if (result.data.gateway.discord.enabled && !result.data.gateway.discord.token) {
			warnings.push('Discord gateway enabled but token not configured');
		}

		return {
			valid: errors.length === 0,
			validFields: Object.keys(parsed),
			missingFields: [],
			warnings,
			errors,
		};
	}	}

	return {
		valid: false,
		validFields: Object.keys(parsed).filter(
			(k) => !result.error.issues.some((i) => i.path[0] === k)
		),
		missingFields: result.error.issues
			.filter((i) => i.code === 'invalid_type' && i.received === 'undefined')
			.map((i) => i.path.join('.')),
		warnings: [],
		errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
	};
}

// ============================================================================
// Default Configurations
// ============================================================================

/**
 * Get default configuration for single agent mode.
 * Suitable for local development or single-agent deployments.
 */
export function getDefaultSingleConfig(): ConductorConfig {
	const config: ConductorConfig = {
		mode: 'single',
		model: 'moonshotai/kimi-k2.5',
		server: {
			port: 7777,
			host: '0.0.0.0',
		},
		gateway: {
			http: {
				enabled: true,
				auth: undefined,
			},
			discord: {
				enabled: false,
				token: undefined,
				guildId: undefined,
			},
		},
		agent: {
			name: 'local-agent',
			url: 'http://localhost:7600',
			model: 'moonshotai/kimi-k2.5',
		},
		routing: {
			strategy: 'explicit',
		},
	};
	return deepFreeze(config) as ConductorConfig;
}

/**
 * Get default configuration for posse mode.
 * Suitable for distributed multi-agent deployments.
 */
export function getDefaultPosseConfig(): ConductorConfig {
	const config: ConductorConfig = {
		mode: 'posse',
		model: 'moonshotai/kimi-k2.5',
		server: {
			port: 7777,
			host: '0.0.0.0',
		},
		gateway: {
			http: {
				enabled: true,
				auth: undefined,
			},
			discord: {
				enabled: false,
				token: undefined,
				guildId: undefined,
			},
		},
		posse: {
			name: 'default-posse',
			meilisearch: {
				url: process.env.MEILI_URL || 'http://localhost:7700',
				apiKey: process.env.MEILI_API_KEY || '',
			},
			discovery: {
				enabled: true,
				pollInterval: 30000,
			},
		},
		routing: {
			strategy: 'auto',
		},
	};
	return deepFreeze(config) as ConductorConfig;
}

// ============================================================================
// Environment-based Config Loading
// ============================================================================

/**
 * Load configuration from environment variables.
 * Useful for containerized deployments (Railway, Docker, etc.)
 *
 * Environment variables:
 *   CONDUCTOR_MODE - 'single' or 'posse'
 *   CONDUCTOR_MODEL - conductor's LLM model
 *   CONDUCTOR_PORT - server port
 *   CONDUCTOR_HOST - server host
 *   CONDUCTOR_HTTP_ENABLED - enable HTTP gateway
 *   CONDUCTOR_HTTP_AUTH - HTTP auth token
 *   CONDUCTOR_DISCORD_ENABLED - enable Discord gateway
 *   CONDUCTOR_DISCORD_TOKEN - Discord bot token
 *   CONDUCTOR_DISCORD_GUILD_ID - Discord guild ID
 *   CONDUCTOR_ROUTING_STRATEGY - 'auto', 'round-robin', or 'explicit'
 *
 * Single mode:
 *   CONDUCTOR_AGENT_NAME - agent name
 *   CONDUCTOR_AGENT_URL - agent URL
 *   CONDUCTOR_AGENT_MODEL - agent model
 *
 * Posse mode:
 *   CONDUCTOR_POSSE_NAME - posse name
 *   CONDUCTOR_MEILI_URL - Meilisearch URL
 *   CONDUCTOR_MEILI_API_KEY - Meilisearch API key
 *   CONDUCTOR_DISCOVERY_ENABLED - enable agent discovery
 *   CONDUCTOR_DISCOVERY_INTERVAL - discovery poll interval
 */
export function loadConfigFromEnv(): ConductorConfig {
	const mode = (process.env.CONDUCTOR_MODE as 'single' | 'posse') || 'single';

	const baseConfig: ConductorConfig = {
		mode,
		model: process.env.CONDUCTOR_MODEL || 'moonshotai/kimi-k2.5',
		server: {
		port: Number.parseInt(process.env.CONDUCTOR_PORT || '7777', 10),
		host: process.env.CONDUCTOR_HOST || '0.0.0.0',
		},
		gateway: {
			http: {
				enabled: process.env.CONDUCTOR_HTTP_ENABLED !== 'false',
				auth: process.env.CONDUCTOR_HTTP_AUTH,
			},
			discord: {
				enabled: process.env.CONDUCTOR_DISCORD_ENABLED === 'true',
				token: process.env.CONDUCTOR_DISCORD_TOKEN,
				guildId: process.env.CONDUCTOR_DISCORD_GUILD_ID,
			},
		},
		routing: {
			strategy:
				(process.env.CONDUCTOR_ROUTING_STRATEGY as 'auto' | 'round-robin' | 'explicit') ||
				'auto',
		},
	};

	if (mode === 'single') {
		const agentUrl = process.env.CONDUCTOR_AGENT_URL;
		if (!agentUrl) {
			throw new Error(
				'CONDUCTOR_AGENT_URL is required when CONDUCTOR_MODE=single'
			);
		}
		baseConfig.agent = {
			name: process.env.CONDUCTOR_AGENT_NAME || 'local-agent',
			url: agentUrl,
			model: process.env.CONDUCTOR_AGENT_MODEL || 'moonshotai/kimi-k2.5',
		};
	} else {
		const posseName = process.env.CONDUCTOR_POSSE_NAME;
		if (!posseName) {
			throw new Error(
				'CONDUCTOR_POSSE_NAME is required when CONDUCTOR_MODE=posse'
			);
		}
		baseConfig.posse = {
			name: posseName,
			meilisearch: {
				url: process.env.CONDUCTOR_MEILI_URL || 'http://localhost:7700',
				apiKey: process.env.CONDUCTOR_MEILI_API_KEY || '',
			},
			discovery: {
				enabled: process.env.CONDUCTOR_DISCOVERY_ENABLED !== 'false',
				pollInterval: Number.parseInt(
					process.env.CONDUCTOR_DISCOVERY_INTERVAL || '30000',
					10
				),
			},
		};
	}

	return deepFreeze(baseConfig) as ConductorConfig;
}
