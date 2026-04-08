import type { RandalConfig } from "./config.js";
import baseTemplate from "./opencode-base.json";

// ---- Types ----

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
 * @param config - A validated, frozen RandalConfig
 * @param options - Paths and overrides controlling compilation
 * @returns A fully populated OpenCode configuration object
 */
export function compileOpenCodeConfig(
	config: RandalConfig,
	options: CompileOptions,
): OpenCodeConfig {
	const toolsDir = resolveToolsDir(options);

	// Start from a deep clone of the base template so we never mutate the import
	const result: OpenCodeConfig = structuredClone(baseTemplate) as OpenCodeConfig;

	// Populate MCP servers based on config + capabilities
	result.mcp = buildMcpSection(config, toolsDir);

	// Populate tool permissions based on capabilities
	result.tools = buildToolsSection(config);

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
function hasCapability(
	config: RandalConfig,
	...names: string[]
): boolean {
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
 * Build the `mcp` section of the opencode.json based on config state.
 *
 * Each MCP server is conditionally included based on the Randal config:
 *   - memory: when `config.memory.store` is set
 *   - scheduler: when heartbeat is enabled or cron jobs exist
 *   - tavily: when "search" or "tavily" is in capabilities
 *   - video: when "video" is in capabilities or tools
 *   - image-gen: when "image-gen" is in capabilities or tools
 */
function buildMcpSection(
	config: RandalConfig,
	toolsDir: string,
): Record<string, McpServerEntry> {
	const mcp: Record<string, McpServerEntry> = {};

	// Memory MCP — always present when memory store is configured
	if (config.memory.store) {
		mcp.memory = {
			type: "local",
			command: ["bun", "run", `${toolsDir}/mcp-memory-server.ts`],
			environment: {
				MEILI_URL: config.memory.url,
				...(config.runner.defaultModel
					? { SUMMARY_MODEL: config.runner.defaultModel.includes("haiku")
						? config.runner.defaultModel
						: "anthropic/claude-haiku-3" }
					: { SUMMARY_MODEL: "anthropic/claude-haiku-3" }),
			},
			enabled: true,
		};
	}

	// Scheduler MCP — when heartbeat is enabled or cron jobs exist
	const hasCronJobs = Object.keys(config.cron.jobs).length > 0;
	if (config.heartbeat.enabled || hasCronJobs) {
		mcp.scheduler = {
			type: "local",
			command: ["bun", "run", `${toolsDir}/mcp-scheduler-server.ts`],
			environment: {
				RANDAL_GATEWAY_URL: "http://localhost:7600",
				RANDAL_GATEWAY_TOKEN: "{env:RANDAL_GATEWAY_TOKEN}",
			},
			enabled: true,
		};
	}

	// Tavily MCP — when "search" or "tavily" capability is listed
	if (hasCapability(config, "search", "tavily")) {
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
