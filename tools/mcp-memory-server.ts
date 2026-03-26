#!/usr/bin/env bun
/**
 * Standalone MCP stdio server for agent memory backed by Meilisearch.
 *
 * Designed to be used as an OpenCode MCP server (configured in opencode.json).
 * Agents can search and store long-term memory through three tools:
 *   - memory_search  — hybrid semantic + keyword search with scope filtering
 *   - memory_store   — index a new memory document (with dedup and auto-scope)
 *   - memory_recent  — retrieve N most recent memories
 *
 * Communication: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 *
 * Environment variables:
 *   MEILI_URL            — Meilisearch URL (default: http://localhost:7700)
 *   MEILI_MASTER_KEY     — optional Meilisearch API key
 *   MEILI_INDEX          — index name (default: memory-randal)
 *   OPENROUTER_API_KEY   — OpenRouter API key for semantic embeddings (optional)
 *   EMBEDDING_MODEL      — embedding model (default: openai/text-embedding-3-small)
 *   EMBEDDING_URL        — embedding endpoint (default: https://openrouter.ai/api/v1/embeddings)
 *   SEMANTIC_RATIO       — hybrid search ratio 0-1 (default: 0.7, higher = more semantic)
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { MeilisearchStore } from "@randal/memory";
import type { EmbedderConfig } from "@randal/memory";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7700";
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || "";
const MEILI_INDEX = process.env.MEILI_INDEX || "memory-randal";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
const EMBEDDING_URL = process.env.EMBEDDING_URL || "https://openrouter.ai/api/v1/embeddings";
const SEMANTIC_RATIO = Number.parseFloat(process.env.SEMANTIC_RATIO || "0.7");

/** Categories that default to global scope (cross-project). */
const GLOBAL_SCOPE_CATEGORIES = new Set(["preference", "fact"]);

// ---------------------------------------------------------------------------
// Project scope auto-detection
// ---------------------------------------------------------------------------

let defaultScope = "global";
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
// Store construction
// ---------------------------------------------------------------------------

const embedder: EmbedderConfig | undefined = OPENROUTER_API_KEY
	? {
			type: "openrouter",
			apiKey: OPENROUTER_API_KEY,
			model: EMBEDDING_MODEL,
			url: EMBEDDING_URL,
		}
	: undefined;

const store = new MeilisearchStore({
	url: MEILI_URL,
	apiKey: MEILI_MASTER_KEY,
	index: MEILI_INDEX,
	embedder,
	semanticRatio: Number.isFinite(SEMANTIC_RATIO) ? SEMANTIC_RATIO : 0.7,
});

/** Whether the store initialized successfully. */
let storeAvailable = false;

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC error codes
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// MCP tool schema definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
	{
		name: "memory_search",
		description:
			"Search Randal's long-term memory for relevant context, past learnings, patterns, and preferences. Returns matching memories sorted by relevance.",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "Full-text search query" },
				limit: {
					type: "number",
					description: "Maximum number of results to return (default 10)",
				},
				category: {
					type: "string",
					description:
						"Optional category filter: preference, pattern, fact, lesson, escalation, skill-outcome, session-start, session-progress, session-complete, session-error, session-paused",
				},
				scope: {
					type: "string",
					description:
						'Search scope. Default: current project + global memories. Use "all" to search across all projects, or "global" for global-only.',
				},
			},
			required: ["query"],
		},
	},
	{
		name: "memory_store",
		description:
			"Store a new memory in Randal's long-term memory. Automatically deduplicates by content hash. Use this to persist learnings, preferences, patterns, or facts discovered during work.",
		inputSchema: {
			type: "object" as const,
			properties: {
				content: { type: "string", description: "The memory content to store" },
				category: {
					type: "string",
					description:
						"Memory category: preference, pattern, fact, lesson, escalation, skill-outcome",
				},
				source: {
					type: "string",
					description:
						'Source of the memory: "self", "agent:<name>", or "human" (default: "self")',
				},
				scope: {
					type: "string",
					description:
						'Explicit scope override. Default: auto-assigned based on category (preference/fact → global, others → current project).',
				},
			},
			required: ["content", "category"],
		},
	},
	{
		name: "memory_recent",
		description:
			"Retrieve the most recent memories from Randal's long-term memory, sorted by timestamp descending.",
		inputSchema: {
			type: "object" as const,
			properties: {
				limit: {
					type: "number",
					description: "Number of recent memories to return (default 10)",
				},
			},
			required: [],
		},
	},
];

// ---------------------------------------------------------------------------
// Tool handlers — thin wrappers over MeilisearchStore
// ---------------------------------------------------------------------------

class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

/**
 * Resolve the scope for a search request.
 * - If explicit scope is provided, use it.
 * - Otherwise, use the auto-detected project scope (includes global + project).
 */
function resolveSearchScope(explicitScope: string | undefined): string | undefined {
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
function resolveStoreScope(category: string, explicitScope: string | undefined): string {
	if (explicitScope) {
		return explicitScope;
	}
	if (GLOBAL_SCOPE_CATEGORIES.has(category)) {
		return "global";
	}
	return defaultScope;
}

async function handleMemorySearch(params: Record<string, unknown>): Promise<unknown> {
	const query = params.query as string;
	if (!query) {
		throw new ToolError("Missing required parameter: query");
	}

	const limit = typeof params.limit === "number" ? params.limit : 10;
	const scope = resolveSearchScope(params.scope as string | undefined);

	if (!storeAvailable) {
		return { results: [], message: "Meilisearch is not available" };
	}

	try {
		const docs = await store.search(query, limit, scope ? { scope } : undefined);

		return {
			results: docs.map((doc) => ({
				id: doc.id,
				type: doc.type,
				category: doc.category,
				content: doc.content,
				source: doc.source,
				scope: doc.scope,
				timestamp: doc.timestamp,
			})),
		};
	} catch (err) {
		log("error", `memory_search failed: ${err instanceof Error ? err.message : String(err)}`);
		return { results: [], message: "Search failed" };
	}
}

async function handleMemoryStore(params: Record<string, unknown>): Promise<unknown> {
	const content = params.content as string;
	const category = params.category as string;
	const source = (params.source as string) || "self";
	const explicitScope = params.scope as string | undefined;

	if (!content) {
		throw new ToolError("Missing required parameter: content");
	}
	if (!category) {
		throw new ToolError("Missing required parameter: category");
	}

	if (!storeAvailable) {
		return { stored: false, message: "Meilisearch is not available" };
	}

	try {
		const contentHash = createHash("sha256").update(content).digest("hex");
		const scope = resolveStoreScope(category, explicitScope);

		await store.index({
			type: "learning",
			file: "",
			content,
			contentHash,
			category: category as
				| "preference"
				| "pattern"
				| "fact"
				| "lesson"
				| "escalation"
				| "skill-outcome",
			source: source as "self" | `agent:${string}` | "human",
			timestamp: new Date().toISOString(),
			scope,
		});

		return {
			stored: true,
			contentHash,
			scope,
			message: "Memory stored successfully",
		};
	} catch (err) {
		log("error", `memory_store failed: ${err instanceof Error ? err.message : String(err)}`);
		return { stored: false, message: "Store operation failed" };
	}
}

async function handleMemoryRecent(params: Record<string, unknown>): Promise<unknown> {
	const limit = typeof params.limit === "number" ? params.limit : 10;

	if (!storeAvailable) {
		return { results: [], message: "Meilisearch is not available" };
	}

	try {
		const docs = await store.recent(limit);

		return {
			results: docs.map((doc) => ({
				id: doc.id,
				type: doc.type,
				category: doc.category,
				content: doc.content,
				source: doc.source,
				scope: doc.scope,
				timestamp: doc.timestamp,
			})),
		};
	} catch (err) {
		log("error", `memory_recent failed: ${err instanceof Error ? err.message : String(err)}`);
		return { results: [], message: "Recent query failed" };
	}
}

/** Map tool names to handlers */
const TOOL_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
	memory_search: handleMemorySearch,
	memory_store: handleMemoryStore,
	memory_recent: handleMemoryRecent,
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a validated JSON-RPC request to the correct handler.
 */
async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
	const { id, method, params } = req;

	// --- initialize ---
	if (method === "initialize") {
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				serverInfo: { name: "randal-memory", version: "0.2.0" },
				capabilities: {
					tools: { listChanged: false },
				},
			},
		};
	}

	// --- notifications (no response required) ---
	if (method === "notifications/initialized") {
		// Client acknowledgement — no response needed
		return undefined as unknown as JsonRpcResponse;
	}

	// --- ping ---
	if (method === "ping") {
		return { jsonrpc: "2.0", id, result: {} };
	}

	// --- tools/list ---
	if (method === "tools/list") {
		return {
			jsonrpc: "2.0",
			id,
			result: { tools: TOOL_DEFINITIONS },
		};
	}

	// --- tools/call ---
	if (method === "tools/call") {
		const callParams = (params ?? {}) as {
			name?: string;
			arguments?: Record<string, unknown>;
		};

		if (!callParams.name) {
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: RPC_INVALID_PARAMS,
					message: "Missing tool name in params.name",
				},
			};
		}

		const handler = TOOL_HANDLERS[callParams.name];
		if (!handler) {
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: RPC_METHOD_NOT_FOUND,
					message: `Unknown tool: ${callParams.name}`,
				},
			};
		}

		try {
			const result = await handler(callParams.arguments ?? {});
			return {
				jsonrpc: "2.0",
				id,
				result: {
					content: [
						{
							type: "text",
							text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
						},
					],
				},
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			// ToolError = invalid params from the user, otherwise internal
			if (err instanceof ToolError) {
				return {
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					},
				};
			}

			log("error", `Tool ${callParams.name} threw: ${message}`);
			return {
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: `Internal error: ${message}` }],
					isError: true,
				},
			};
		}
	}

	// --- unknown method ---
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: RPC_METHOD_NOT_FOUND,
			message: `Unknown method: ${method}`,
		},
	};
}

// ---------------------------------------------------------------------------
// Stdio transport — newline-delimited JSON-RPC 2.0
// ---------------------------------------------------------------------------

/**
 * Write a JSON-RPC response to stdout.
 */
function send(response: JsonRpcResponse): void {
	const line = `${JSON.stringify(response)}\n`;
	process.stdout.write(line);
}

/**
 * Log a message to stderr (never stdout, which is reserved for JSON-RPC).
 */
function log(level: "info" | "warn" | "error", message: string): void {
	const ts = new Date().toISOString();
	process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${message}\n`);
}

/**
 * Process a single line of input as a JSON-RPC request.
 */
async function processLine(line: string): Promise<void> {
	const trimmed = line.trim();
	if (!trimmed) return;

	// Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		send({
			jsonrpc: "2.0",
			id: null,
			error: { code: RPC_PARSE_ERROR, message: "Invalid JSON" },
		});
		return;
	}

	const req = parsed as Partial<JsonRpcRequest>;

	// Validate JSON-RPC structure
	if (!req.jsonrpc || req.jsonrpc !== "2.0" || !req.method) {
		send({
			jsonrpc: "2.0",
			id: req.id ?? null,
			error: { code: RPC_INVALID_REQUEST, message: "Invalid JSON-RPC request" },
		});
		return;
	}

	// Notifications (no id) don't get a response
	const isNotification = req.id === undefined || req.id === null;

	try {
		const response = await dispatch(req as JsonRpcRequest);

		// Only send a response for requests (not notifications), and only if
		// the handler returned one
		if (!isNotification && response) {
			send(response);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log("error", `Unhandled dispatch error: ${message}`);

		if (!isNotification) {
			send({
				jsonrpc: "2.0",
				id: req.id ?? null,
				error: { code: RPC_INTERNAL_ERROR, message },
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Main — stdin line reader
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	log("info", `randal-memory MCP server starting (index: ${MEILI_INDEX}, scope: ${defaultScope})`);

	// Initialize MeilisearchStore (non-fatal if unavailable)
	try {
		await store.init();
		storeAvailable = true;
		log("info", `Store initialized at ${MEILI_URL} (embedder: ${embedder ? "openrouter" : "none"})`);
	} catch (err) {
		storeAvailable = false;
		log(
			"warn",
			`Store initialization failed at ${MEILI_URL}: ${err instanceof Error ? err.message : String(err)}. Tools will return empty results.`,
		);
	}

	log("info", "Listening on stdin for JSON-RPC requests...");

	// Read stdin as a stream of newline-delimited JSON
	const decoder = new TextDecoder();
	let buffer = "";

	const stdin = Bun.stdin.stream();
	const reader = stdin.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Process complete lines
			let newlineIdx: number = buffer.indexOf("\n");
			while (newlineIdx !== -1) {
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				await processLine(line);
				newlineIdx = buffer.indexOf("\n");
			}
		}

		// Process any remaining data in the buffer (no trailing newline)
		if (buffer.trim()) {
			await processLine(buffer);
		}
	} catch (err) {
		// stdin closed or read error — exit cleanly
		const message = err instanceof Error ? err.message : String(err);
		log("info", `stdin closed: ${message}`);
	}

	log("info", "MCP server shutting down");
}

main().catch((err) => {
	log("error", `Fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
