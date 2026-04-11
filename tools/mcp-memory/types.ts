/**
 * Shared types, constants, and configuration for the MCP memory server modules.
 *
 * All process.env reads are centralized here so handler modules don't need
 * to reach into the environment directly.
 */

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Meilisearch configuration
// ---------------------------------------------------------------------------

export const MEILI_URL = process.env.MEILI_URL || "http://localhost:7700";
export const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || "";
export const MEILI_INDEX = process.env.MEILI_INDEX || "memory-randal";
export const MEILI_DUMP_INTERVAL_MS = Number.parseInt(
	process.env.MEILI_DUMP_INTERVAL_MS || String(6 * 60 * 60 * 1000),
	10,
);

// ---------------------------------------------------------------------------
// Embedding / LLM configuration
// ---------------------------------------------------------------------------

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
export const EMBEDDING_URL = process.env.EMBEDDING_URL || "https://openrouter.ai/api/v1/embeddings";
export const SEMANTIC_RATIO = Number.parseFloat(process.env.SEMANTIC_RATIO || "0.7");
export const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "anthropic/claude-haiku-3";

// ---------------------------------------------------------------------------
// Analytics configuration
// ---------------------------------------------------------------------------

export const ANALYTICS_ENABLED = process.env.ANALYTICS_ENABLED !== "false";
export const INSTANCE_NAME = process.env.RANDAL_INSTANCE_NAME || "randal";

// ---------------------------------------------------------------------------
// Channel-awareness: origin metadata injected by the runner
// ---------------------------------------------------------------------------

export const RANDAL_JOB_ID = process.env.RANDAL_JOB_ID || "";
export const RANDAL_CHANNEL = process.env.RANDAL_CHANNEL || "";
export const RANDAL_FROM = process.env.RANDAL_FROM || "";
export const RANDAL_REPLY_TO = process.env.RANDAL_REPLY_TO || "";
export const RANDAL_TRIGGER = process.env.RANDAL_TRIGGER || "";
export const RANDAL_BRAIN_SESSION = process.env.RANDAL_BRAIN_SESSION || "";
export const RANDAL_GATEWAY_AUTH = process.env.RANDAL_GATEWAY_AUTH || "";

// ---------------------------------------------------------------------------
// Posse configuration — enables cross-instance delegation tools
// ---------------------------------------------------------------------------

export const RANDAL_POSSE_NAME = process.env.RANDAL_POSSE_NAME || "";
export const RANDAL_SELF_NAME = process.env.RANDAL_SELF_NAME || "";
export const RANDAL_GATEWAY_URL = process.env.RANDAL_GATEWAY_URL || "";
export const RANDAL_CROSS_AGENT_READ_FROM = process.env.RANDAL_CROSS_AGENT_READ_FROM || "";
export const RANDAL_PEER_AUTH_TOKEN = process.env.RANDAL_PEER_AUTH_TOKEN || "";

// ---------------------------------------------------------------------------
// McpServerConfig — typed shape for the config subset used by the MCP server
// ---------------------------------------------------------------------------

/**
 * The subset of RandalConfig fields actually consumed by the MCP server.
 *
 * Instead of casting through `unknown` to satisfy the full RandalConfig,
 * handler code constructs this typed shape from env vars. Subsystem consumers
 * (MessageManager, queryPosseMembers, searchCrossAgent) receive the appropriate
 * slices cast to RandalConfig at the boundary.
 */
export interface McpServerConfig {
	name: string;
	memory: {
		url: string;
		apiKey: string;
		store: "meilisearch";
		sharing: {
			readFrom: string[];
			publishTo: string;
		};
	};
	posse: string;
	mesh: {
		endpoint: string;
	};
}

/**
 * Build the McpServerConfig from env vars (called once at module load).
 */
export function buildMcpServerConfig(): McpServerConfig {
	return {
		name: RANDAL_SELF_NAME || "randal",
		memory: {
			url: MEILI_URL,
			apiKey: MEILI_MASTER_KEY,
			store: "meilisearch",
			sharing: {
				readFrom: RANDAL_CROSS_AGENT_READ_FROM
					? RANDAL_CROSS_AGENT_READ_FROM.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: [],
				publishTo: "",
			},
		},
		posse: RANDAL_POSSE_NAME,
		mesh: {
			endpoint: RANDAL_GATEWAY_URL,
		},
	};
}

// ---------------------------------------------------------------------------
// Scope constants and helpers
// ---------------------------------------------------------------------------

/** Categories that default to global scope (cross-project). */
export const GLOBAL_SCOPE_CATEGORIES = new Set(["preference", "fact"]);

/** Standard hint for Meilisearch connectivity issues. */
export const MEILI_HINT = "Check MEILI_URL and MEILI_MASTER_KEY environment variables";

/**
 * Auto-detected project scope from git root.
 * "global" if not inside a git repo, or "project:/path/to/repo" if in one.
 */
export let defaultScope = "global";
try {
	const gitRoot = execSync("git rev-parse --show-toplevel", {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
	if (gitRoot) {
		defaultScope = `project:${gitRoot}`;
	}
} catch {
	// Not in a git repo — default to global
}

// ---------------------------------------------------------------------------
// Scope resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the scope for a search request.
 * - If explicit scope is provided, use it.
 * - Otherwise, use the auto-detected project scope (includes global + project).
 */
export function resolveSearchScope(explicitScope: string | undefined): string | undefined {
	if (explicitScope) {
		return explicitScope;
	}
	// defaultScope is "global" if not in a git repo, or "project:/path" if in one.
	// When defaultScope is "global", pass undefined to skip scope filtering (backward-compatible).
	if (defaultScope === "global") {
		return undefined;
	}
	return defaultScope;
}

/**
 * Resolve the scope for a store operation.
 * - If explicit scope is provided, use it.
 * - If category is preference/fact, use "global".
 * - Otherwise, use the auto-detected project scope.
 */
export function resolveStoreScope(category: string, explicitScope: string | undefined): string {
	if (explicitScope) {
		return explicitScope;
	}
	if (GLOBAL_SCOPE_CATEGORIES.has(category)) {
		return "global";
	}
	return defaultScope;
}
