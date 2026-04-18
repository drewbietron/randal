import type { RandalConfig } from "./config.js";
import baseTemplate from "./opencode-base.json";
import { interpolateTemplate } from "./resolve-prompt.js";

// ---- Types ----

/**
 * Pre-resolved identity content for injection into the compiled config.
 *
 * When provided, the compile function uses this instead of performing
 * async I/O to resolve persona files/modules. This keeps the core
 * compile path synchronous and pure.
 */
export interface ResolvedIdentity {
	/** The fully resolved persona text (after file loading / module execution) */
	persona?: string;
	/** Resolved rules (after file loading / splitting) */
	rules?: string[];
	/** Resolved knowledge entries (after file loading / glob expansion) */
	knowledge?: string[];
}

/**
 * Metadata about how identity was resolved during compilation.
 * Returned alongside the OpenCode config for downstream consumers
 * (e.g., writing persona to a known location, logging, dry-run output).
 */
export interface CompileResult {
	/** The generated OpenCode configuration object */
	config: OpenCodeConfig;
	/** The resolved and interpolated persona text, if available */
	resolvedPersona?: string;
	/** The resolved and interpolated rules, if available */
	resolvedRules?: string[];
	/** The resolved and interpolated knowledge entries, if available */
	resolvedKnowledge?: string[];
}

/**
 * Options controlling how the OpenCode config is compiled from a Randal config.
 */
export interface CompileOptions {
	/** Directory containing randal.config.yaml (for resolving relative paths) */
	basePath: string;
	/** Root of the Randal repository/installation (for deriving tool paths) */
	repoRoot?: string;
	/** Directory containing MCP tool server scripts (defaults to `{repoRoot}/tools`) */
	toolsDir?: string;
	/**
	 * Pre-resolved identity content. When provided, template interpolation
	 * ({{var}} replacement via identity.vars) is applied to persona, rules,
	 * and knowledge. This avoids async I/O in the core compile path.
	 */
	resolvedIdentity?: ResolvedIdentity;
}

/**
 * An MCP server entry in the generated opencode.json.
 * Covers both local (command-based) and remote (URL-based) servers.
 */
export interface McpServerEntry {
	type: "local" | "remote";
	/** Command array for local servers (e.g., ["bun", "run", "/path/to/server.ts"]) */
	command?: string[];
	/** URL for remote servers */
	url?: string;
	/** Environment variables passed to the MCP server process */
	environment?: Record<string, string>;
	/** Whether this server is enabled */
	enabled: boolean;
}

/**
 * The shape of a generated opencode.json configuration.
 */
export interface OpenCodeConfig {
	$schema: string;
	plugin: string[];
	agent: {
		build: { disable: boolean };
		plan: { disable: boolean };
	};
	mcp: Record<string, McpServerEntry>;
	tools: Record<string, boolean>;
}

// ---- Core compiler ----

/**
 * Compile a Randal config into an OpenCode configuration object.
 *
 * This is the core generation function: it merges the static base template
 * (`opencode.base.json`) with dynamic values derived from the Randal config
 * (MCP servers, tool permissions, etc.).
 *
 * The returned object is a plain JSON-serializable value suitable for writing
 * to `~/.config/opencode/opencode.json`. This function does NOT perform I/O —
 * it returns a value; the caller decides where to write it.
 *
 * When `options.resolvedIdentity` is provided, template interpolation using
 * `config.identity.vars` is applied to persona, rules, and knowledge content.
 * The interpolated results are returned in the `CompileResult` for downstream
 * consumers (e.g., writing persona to a known file, dry-run display).
 *
 * @param config - A validated, frozen RandalConfig
 * @param options - Paths and overrides controlling compilation
 * @returns A CompileResult containing the config and resolved identity metadata
 */
export function compileOpenCodeConfig(
	config: RandalConfig,
	options: CompileOptions,
): CompileResult {
	const toolsDir = resolveToolsDir(options);

	// Start from a deep clone of the base template so we never mutate the import
	const openCodeConfig: OpenCodeConfig = structuredClone(baseTemplate) as OpenCodeConfig;

	// Populate MCP servers based on config + capabilities
	openCodeConfig.mcp = buildMcpSection(config, toolsDir);

	// Populate tool permissions based on capabilities
	openCodeConfig.tools = buildToolsSection(config);

	// Resolve identity: apply {{var}} interpolation from identity.vars
	const identityResult = resolveIdentity(config, options.resolvedIdentity);

	return {
		config: openCodeConfig,
		...identityResult,
	};
}

// ---- Identity resolution ----

/**
 * Apply template interpolation to pre-resolved identity content.
 *
 * Uses `identity.vars` from the config to replace `{{key}}` patterns
 * in persona text, rules, and knowledge entries. This mirrors the
 * interpolation behavior in `resolve-prompt.ts` but operates on
 * already-loaded content rather than performing I/O.
 *
 * @param config - The Randal config (provides identity.vars)
 * @param resolved - Pre-resolved identity content (optional)
 * @returns Interpolated identity fields for inclusion in CompileResult
 */
function resolveIdentity(
	config: RandalConfig,
	resolved?: ResolvedIdentity,
): Omit<CompileResult, "config"> {
	if (!resolved) {
		return {};
	}

	const vars = config.identity.vars;

	const result: Omit<CompileResult, "config"> = {};

	if (resolved.persona !== undefined) {
		result.resolvedPersona = interpolateTemplate(resolved.persona, vars);
	}

	if (resolved.rules !== undefined) {
		result.resolvedRules = resolved.rules.map((rule) => interpolateTemplate(rule, vars));
	}

	if (resolved.knowledge !== undefined) {
		result.resolvedKnowledge = resolved.knowledge.map((entry) => interpolateTemplate(entry, vars));
	}

	return result;
}

// ---- Internal helpers ----

/**
 * Resolve the tools directory from compile options.
 * Falls back to `{repoRoot}/tools` if `toolsDir` is not explicitly set.
 */
function resolveToolsDir(options: CompileOptions): string {
	if (options.toolsDir) {
		return options.toolsDir;
	}
	if (options.repoRoot) {
		return `${options.repoRoot}/tools`;
	}
	// Fallback: tools dir relative to basePath (common in dev)
	return `${options.basePath}/tools`;
}

/**
 * Check whether a given capability is active.
 * A capability is active if it appears in `config.capabilities` or if a
 * matching tool exists in `config.tools[]`.
 */
function hasCapability(config: RandalConfig, ...names: string[]): boolean {
	for (const name of names) {
		if (config.capabilities.includes(name)) {
			return true;
		}
		if (config.tools.some((t) => t.name === name)) {
			return true;
		}
	}
	return false;
}

/**
 * Derive the gateway URL from config.
 * Looks for an HTTP channel in the gateway config; falls back to localhost:7600.
 */
function deriveGatewayUrl(config: RandalConfig): string {
	const httpChannel = config.gateway.channels.find((ch) => ch.type === "http");
	if (httpChannel && httpChannel.type === "http") {
		return `http://localhost:${httpChannel.port}`;
	}
	return "http://localhost:7600";
}

/**
 * Derive the summary model for memory MCP.
 * Uses a lightweight model for summarization — defaults to claude-haiku-3.
 */
function deriveSummaryModel(config: RandalConfig): string {
	const model = config.runner.defaultModel;
	// If the default model is already a haiku variant, use it
	if (model.includes("haiku")) {
		return model;
	}
	// If using OpenAI models, use a lightweight OpenAI model for summaries
	if (model.startsWith("openai/")) {
		return "openai/gpt-5.4-mini-fast";
	}
	return "anthropic/claude-haiku-3";
}

/**
 * Build the `mcp` section of the opencode.json based on config state.
 *
 * Each MCP server is conditionally included based on the Randal config:
 *   - memory: when `config.memory.store` is set
 *   - scheduler: when heartbeat is enabled or cron jobs exist
 *   - tavily: when "search" or "tavily" is in capabilities, OR when TAVILY_API_KEY is in env
 *   - video: when "video" is in capabilities or tools
 *   - image-gen: when "image-gen" is in capabilities or tools
 *
 * All local MCP server paths use the resolved `toolsDir`, never hardcoded absolute paths.
 */
function buildMcpSection(config: RandalConfig, toolsDir: string): Record<string, McpServerEntry> {
	const mcp: Record<string, McpServerEntry> = {};

	// Memory MCP — always present when memory store is configured
	if (config.memory.store) {
		const memoryEnv: Record<string, string> = {
			MEILI_URL: config.memory.url,
			SUMMARY_MODEL: deriveSummaryModel(config),
		};

		// Pass through Meilisearch API key if configured
		if (config.memory.apiKey) {
			memoryEnv.MEILI_API_KEY = config.memory.apiKey;
		}

		mcp.memory = {
			type: "local",
			command: ["bun", "run", `${toolsDir}/mcp-memory-server.ts`],
			environment: memoryEnv,
			enabled: true,
		};
	}

	// Scheduler MCP — when heartbeat is enabled or cron jobs exist
	const hasCronJobs = Object.keys(config.cron.jobs).length > 0;
	if (config.heartbeat.enabled || hasCronJobs) {
		const gatewayUrl = deriveGatewayUrl(config);

		mcp.scheduler = {
			type: "local",
			command: ["bun", "run", `${toolsDir}/mcp-scheduler-server.ts`],
			environment: {
				RANDAL_GATEWAY_URL: gatewayUrl,
				RANDAL_GATEWAY_AUTH: "{env:RANDAL_GATEWAY_AUTH}",
			},
			enabled: true,
		};
	}

	// Tavily MCP — when "search" or "tavily" capability is listed, or TAVILY_API_KEY is in env
	const hasTavilyKey = typeof process !== "undefined" && !!process.env.TAVILY_API_KEY;
	if (hasCapability(config, "search", "tavily") || hasTavilyKey) {
		mcp.tavily = {
			type: "remote",
			url: "https://mcp.tavily.com/mcp/?tavilyApiKey={env:TAVILY_API_KEY}",
			enabled: true,
		};
	}

	// Video MCP — when "video" capability or tool exists
	if (hasCapability(config, "video")) {
		mcp.video = {
			type: "local",
			command: ["bun", "run", `${toolsDir}/video/mcp-server.ts`],
			environment: {
				GOOGLE_AI_STUDIO_KEY: "{env:GOOGLE_AI_STUDIO_KEY}",
			},
			enabled: true,
		};
	}

	// Image-gen MCP — when "image-gen" capability or tool exists
	if (hasCapability(config, "image-gen")) {
		mcp["image-gen"] = {
			type: "local",
			command: ["bun", "run", `${toolsDir}/image-gen/mcp-server.ts`],
			enabled: true,
		};
	}

	return mcp;
}

/**
 * Build the `tools` section (tool permission enables) based on capabilities.
 *
 * Each capability that has associated MCP tools gets a wildcard enable entry.
 * For example, if "video" is a capability, `video_*: true` enables all video tools.
 */
function buildToolsSection(config: RandalConfig): Record<string, boolean> {
	const tools: Record<string, boolean> = {};

	if (hasCapability(config, "video")) {
		tools["video_*"] = true;
	}

	if (hasCapability(config, "image-gen")) {
		tools["image-gen_*"] = true;
	}

	return tools;
}
