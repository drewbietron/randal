#!/usr/bin/env bun
/**
 * Standalone MCP stdio server for agent memory backed by Meilisearch.
 *
 * Designed to be used as an OpenCode MCP server (configured in opencode.json).
 * Agents can search and store long-term memory through three tools:
 *   - memory_search  — full-text search with optional category filter
 *   - memory_store   — index a new memory document (with dedup)
 *   - memory_recent  — retrieve N most recent memories
 *
 * Communication: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 *
 * Environment variables:
 *   MEILI_URL         — Meilisearch URL (default: http://localhost:7700)
 *   MEILI_MASTER_KEY  — optional Meilisearch API key
 *   MEILI_INDEX       — index name (default: memory-randal)
 */

import { createHash, randomUUID } from "node:crypto";
import { MeiliSearch } from "meilisearch";

// ---------------------------------------------------------------------------
// Types — replicated from @randal/core so this script has zero internal deps
// ---------------------------------------------------------------------------

type MemoryDocType = "snapshot" | "learning" | "context" | "session";

type MemoryCategory =
	| "preference"
	| "pattern"
	| "fact"
	| "lesson"
	| "escalation"
	| "skill-outcome"
	| "session-start"
	| "session-progress"
	| "session-complete"
	| "session-error"
	| "session-paused";

type MemorySource = "self" | `agent:${string}` | "human" | string;

interface MemoryDoc {
	id: string;
	type: MemoryDocType;
	file: string;
	content: string;
	contentHash: string;
	category: MemoryCategory;
	source: MemorySource;
	timestamp: string;
	jobId?: string;
	iteration?: number;
	sessionId?: string;
	status?: string;
	planFile?: string;
	branch?: string;
	progress?: string;
}

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
					description: 'Source of the memory: "self", "agent:<name>", or "human" (default: "self")',
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
// Meilisearch client setup
// ---------------------------------------------------------------------------

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7700";
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || "";
const MEILI_INDEX = process.env.MEILI_INDEX || "memory-randal";

const client = new MeiliSearch({
	host: MEILI_URL,
	apiKey: MEILI_MASTER_KEY || undefined,
});

/** Whether Meilisearch is available. Set during init. */
let meiliAvailable = false;

/**
 * Initialize the Meilisearch index with the correct schema configuration.
 * If Meilisearch is unreachable, logs a warning and continues — tools will
 * return graceful empty results.
 */
async function initIndex(): Promise<void> {
	try {
		const index = client.index(MEILI_INDEX);

		// Configure searchable, filterable, and sortable attributes
		await index.updateSearchableAttributes(["content", "category", "type", "source"]);
		await index.updateFilterableAttributes([
			"type",
			"category",
			"source",
			"file",
			"timestamp",
			"contentHash",
		]);
		await index.updateSortableAttributes(["timestamp"]);

		meiliAvailable = true;
		log("info", `Meilisearch index "${MEILI_INDEX}" initialized at ${MEILI_URL}`);
	} catch (err) {
		meiliAvailable = false;
		log(
			"warn",
			`Meilisearch unavailable at ${MEILI_URL}: ${err instanceof Error ? err.message : String(err)}. Tools will return empty results.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Full-text search with optional category filter, sorted by timestamp desc.
 */
async function handleMemorySearch(params: Record<string, unknown>): Promise<unknown> {
	const query = params.query as string;
	if (!query) {
		throw new ToolError("Missing required parameter: query");
	}

	const limit = typeof params.limit === "number" ? params.limit : 10;
	const category = params.category as string | undefined;

	if (!meiliAvailable) {
		return { results: [], message: "Meilisearch is not available" };
	}

	try {
		const index = client.index(MEILI_INDEX);
		const searchOpts: Record<string, unknown> = {
			limit,
			sort: ["timestamp:desc"],
		};

		if (category) {
			searchOpts.filter = `category = "${category}"`;
		}

		const results = await index.search(query, searchOpts);

		return {
			results: (results.hits as unknown as MemoryDoc[]).map((doc) => ({
				id: doc.id,
				type: doc.type,
				category: doc.category,
				content: doc.content,
				source: doc.source,
				timestamp: doc.timestamp,
			})),
		};
	} catch (err) {
		log("error", `memory_search failed: ${err instanceof Error ? err.message : String(err)}`);
		return { results: [], message: "Search failed" };
	}
}

/**
 * Store a new memory document. Deduplicates by SHA-256 content hash.
 */
async function handleMemoryStore(params: Record<string, unknown>): Promise<unknown> {
	const content = params.content as string;
	const category = params.category as MemoryCategory;
	const source = (params.source as string) || "self";

	if (!content) {
		throw new ToolError("Missing required parameter: content");
	}
	if (!category) {
		throw new ToolError("Missing required parameter: category");
	}

	if (!meiliAvailable) {
		return { stored: false, message: "Meilisearch is not available" };
	}

	try {
		const index = client.index(MEILI_INDEX);

		// Compute SHA-256 content hash for dedup
		const contentHash = createHash("sha256").update(content).digest("hex");

		// Check for existing document with the same content hash
		const existing = await index.search("", {
			filter: `contentHash = "${contentHash}"`,
			limit: 1,
		});

		if (existing.hits.length > 0) {
			return {
				stored: false,
				duplicate: true,
				existingId: (existing.hits[0] as unknown as MemoryDoc).id,
				message: "Memory with identical content already exists",
			};
		}

		// Build and index the new document
		const doc: MemoryDoc = {
			id: randomUUID(),
			type: "learning",
			file: "",
			content,
			contentHash,
			category,
			source,
			timestamp: new Date().toISOString(),
		};

		await index.addDocuments([doc]);

		return {
			stored: true,
			id: doc.id,
			contentHash,
			message: "Memory stored successfully",
		};
	} catch (err) {
		log("error", `memory_store failed: ${err instanceof Error ? err.message : String(err)}`);
		return { stored: false, message: "Store operation failed" };
	}
}

/**
 * Retrieve the N most recent memories, sorted by timestamp descending.
 */
async function handleMemoryRecent(params: Record<string, unknown>): Promise<unknown> {
	const limit = typeof params.limit === "number" ? params.limit : 10;

	if (!meiliAvailable) {
		return { results: [], message: "Meilisearch is not available" };
	}

	try {
		const index = client.index(MEILI_INDEX);
		const results = await index.search("", {
			limit,
			sort: ["timestamp:desc"],
		});

		return {
			results: (results.hits as unknown as MemoryDoc[]).map((doc) => ({
				id: doc.id,
				type: doc.type,
				category: doc.category,
				content: doc.content,
				source: doc.source,
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

class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

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
				serverInfo: { name: "randal-memory", version: "0.1.0" },
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
 * Uses Bun.write for reliable, non-blocking output.
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
	log("info", `randal-memory MCP server starting (index: ${MEILI_INDEX})`);

	// Initialize Meilisearch (non-fatal if unavailable)
	await initIndex();

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
