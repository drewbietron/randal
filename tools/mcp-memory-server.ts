#!/usr/bin/env bun
/**
 * Standalone MCP stdio server for agent memory and chat history backed by Meilisearch.
 *
 * Designed to be used as an OpenCode MCP server (configured in opencode.json).
 * Agents can search and store long-term memory and chat history through tools:
 *   - memory_search  — hybrid semantic + keyword search with scope filtering
 *   - memory_store   — index a new memory document (with dedup and auto-scope)
 *   - memory_recent  — retrieve N most recent memories
 *   - chat_search    — search past conversations (semantic + keyword)
 *   - chat_thread    — retrieve a specific conversation thread by ID
 *   - chat_recent    — list recent conversation threads
 *   - chat_log       — persist a message to chat history
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
 *   SUMMARY_MODEL        — LLM model for chat summaries (default: anthropic/claude-haiku-3)
 */

import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { MeilisearchStore, MessageManager } from "@randal/memory";
import type { EmbedderConfig, SummaryGeneratorOptions } from "@randal/memory";

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
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "anthropic/claude-haiku-3";
const MEILI_DUMP_INTERVAL_MS = Number.parseInt(
	process.env.MEILI_DUMP_INTERVAL_MS || String(6 * 60 * 60 * 1000),
	10,
);

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

/** Last init failure reason for diagnostics (null = no error). */
let storeInitError: string | null = null;

// ---------------------------------------------------------------------------
// MessageManager construction (chat history)
// ---------------------------------------------------------------------------

// MessageManager expects a RandalConfig-shaped object. We only use the fields
// it actually reads: memory.url, memory.apiKey, and name. Use a type assertion
// for pragmatism — this is the MCP server, not the full platform.
const messageManagerConfig = {
	name: "randal",
	memory: {
		url: MEILI_URL,
		apiKey: MEILI_MASTER_KEY,
	},
};

const summaryGeneratorConfig: SummaryGeneratorOptions | undefined = OPENROUTER_API_KEY
	? {
			apiKey: OPENROUTER_API_KEY,
			model: SUMMARY_MODEL,
		}
	: undefined;

const messageManager = new MessageManager({
	// biome-ignore lint/suspicious/noExplicitAny: Partial RandalConfig — only memory.url, memory.apiKey, name are read
	config: messageManagerConfig as any,
	embedder,
	semanticRatio: Number.isFinite(SEMANTIC_RATIO) ? SEMANTIC_RATIO : 0.7,
	summaryGenerator: summaryGeneratorConfig,
});

/** Whether the message manager initialized successfully. */
let messagesAvailable = false;

/** Last init failure reason for diagnostics (null = no error). */
let messagesInitError: string | null = null;

// ---------------------------------------------------------------------------
// Init retry with exponential backoff & lazy re-init helpers
// ---------------------------------------------------------------------------

/**
 * Classify an init error into a human-readable diagnostic message.
 * Extracts the root cause from common failure patterns without leaking secrets.
 */
function classifyInitError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const lower = raw.toLowerCase();

	if (
		lower.includes("401") ||
		lower.includes("403") ||
		lower.includes("unauthorized") ||
		lower.includes("invalid api key") ||
		lower.includes("invalid_api_key")
	) {
		return `Authentication failed at ${MEILI_URL} — check MEILI_MASTER_KEY`;
	}
	if (
		lower.includes("econnrefused") ||
		lower.includes("fetch failed") ||
		lower.includes("has failed") ||
		lower.includes("connect")
	) {
		return `Connection refused at ${MEILI_URL} — is Meilisearch running?`;
	}
	if (lower.includes("timeout") || lower.includes("etimedout")) {
		return `Connection timed out at ${MEILI_URL}`;
	}
	return raw;
}

/**
 * Retry store.init() and messageManager.init() with exponential backoff.
 * Each subsystem is retried independently so one failing doesn't block the other.
 * Never throws — sets availability flags on success, logs warnings on failure.
 * Stores the last error reason for diagnostic reporting in tool responses.
 */
async function retryInit(): Promise<void> {
	const MAX_ATTEMPTS = 5;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			await store.init();
			storeAvailable = true;
			storeInitError = null;
			log("info", `Store initialized at ${MEILI_URL} (attempt ${attempt})`);
			break;
		} catch (err) {
			storeInitError = classifyInitError(err);
			const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
			log(
				"warn",
				`Store init attempt ${attempt}/${MAX_ATTEMPTS} failed: ${storeInitError}. Retry in ${delay}ms`,
			);
			if (attempt < MAX_ATTEMPTS) await Bun.sleep(delay);
		}
	}
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			await messageManager.init();
			messagesAvailable = true;
			messagesInitError = null;
			log("info", `MessageManager initialized (attempt ${attempt})`);
			break;
		} catch (err) {
			messagesInitError = classifyInitError(err);
			const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
			log(
				"warn",
				`MessageManager init attempt ${attempt}/${MAX_ATTEMPTS} failed: ${messagesInitError}. Retry in ${delay}ms`,
			);
			if (attempt < MAX_ATTEMPTS) await Bun.sleep(delay);
		}
	}
}

/** Lazy re-init: attempt store.init() if not yet available. Returns true if available. */
async function ensureStore(): Promise<boolean> {
	if (storeAvailable) return true;
	try {
		await store.init();
		storeAvailable = true;
		storeInitError = null;
		log("info", "Store lazy re-init succeeded");
		return true;
	} catch (err) {
		storeInitError = classifyInitError(err);
		return false;
	}
}

/** Lazy re-init: attempt messageManager.init() if not yet available. Returns true if available. */
async function ensureMessages(): Promise<boolean> {
	if (messagesAvailable) return true;
	try {
		await messageManager.init();
		messagesAvailable = true;
		messagesInitError = null;
		log("info", "MessageManager lazy re-init succeeded");
		return true;
	} catch (err) {
		messagesInitError = classifyInitError(err);
		return false;
	}
}

/** Get a diagnostic error string for store unavailability. */
function getStoreError(): string {
	return storeInitError ?? "Meilisearch is not available (unknown reason)";
}

/** Get a diagnostic error string for messages unavailability. */
function getMessagesError(): string {
	return messagesInitError ?? "Chat history is not available (unknown reason)";
}

/** Standard hint for Meilisearch connectivity issues. */
const MEILI_HINT = "Check MEILI_URL and MEILI_MASTER_KEY environment variables";

// ---------------------------------------------------------------------------
// Periodic dump scheduling
// ---------------------------------------------------------------------------

/** Schedule periodic Meilisearch dumps via POST /dumps API. */
function startDumpScheduler(): void {
	if (MEILI_DUMP_INTERVAL_MS <= 0) {
		log("info", "Dump scheduling disabled (MEILI_DUMP_INTERVAL_MS <= 0)");
		return;
	}
	log(
		"info",
		`Dump scheduler started: interval ${MEILI_DUMP_INTERVAL_MS}ms (${(MEILI_DUMP_INTERVAL_MS / 3600000).toFixed(1)}h)`,
	);

	setInterval(async () => {
		try {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (MEILI_MASTER_KEY) {
				headers.Authorization = `Bearer ${MEILI_MASTER_KEY}`;
			}
			const resp = await fetch(`${MEILI_URL}/dumps`, {
				method: "POST",
				headers,
			});
			if (resp.ok) {
				const body = await resp.json();
				log("info", `Dump triggered successfully: ${JSON.stringify(body)}`);
			} else {
				log("warn", `Dump request failed: ${resp.status} ${resp.statusText}`);
			}
		} catch (err) {
			log("warn", `Dump request error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, MEILI_DUMP_INTERVAL_MS);
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
			"Search Randal's long-term memory for relevant context, past learnings, patterns, and preferences. Returns matching memories sorted by relevance. Searches using hybrid semantic + keyword matching when an embedding API key is configured; falls back to keyword-only otherwise. By default, returns project-scoped memories + global memories. Use scope: 'all' to search across all projects.",
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
						'Search scope. Omit for project-scoped + global memories (default). Use "all" to search across all projects, or "global" for global-only.',
				},
			},
			required: ["query"],
		},
	},
	{
		name: "memory_store",
		description:
			"Store a new memory in Randal's long-term memory. Automatically deduplicates by content hash. Use this to persist learnings, preferences, patterns, or facts discovered during work. Automatically assigns scope based on category (preference/fact → global, others → project-scoped). Use the scope parameter to override the automatic assignment.",
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
				scope: {
					type: "string",
					description:
						'Explicit scope override. Omit to auto-assign based on category (preference/fact → global, others → current project). Use "global" to force global scope.',
				},
			},
			required: ["content", "category"],
		},
	},
	{
		name: "memory_recent",
		description:
			"Retrieve the most recent memories from Randal's long-term memory, sorted by timestamp descending. Returns recent memories across all scopes.",
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
	// --- Chat history tools ---
	{
		name: "chat_search",
		description:
			"Search chat history for past conversations using semantic + keyword matching. Returns messages and summaries with thread IDs for resumption. Summaries are prioritized over individual messages for broader queries.",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "Search query (semantic + keyword)",
				},
				limit: {
					type: "number",
					description: "Maximum number of results to return (default 10)",
				},
				scope: {
					type: "string",
					description:
						'Search scope. Omit for current project (default). Use "all" for cross-project, "global" for global-only.',
				},
			},
			required: ["query"],
		},
	},
	{
		name: "chat_thread",
		description:
			"Retrieve messages from a specific chat thread by ID. Use this to review a past conversation found via chat_search.",
		inputSchema: {
			type: "object" as const,
			properties: {
				threadId: {
					type: "string",
					description: "The thread ID to retrieve messages for",
				},
				limit: {
					type: "number",
					description: "Maximum number of messages to return (default 50)",
				},
			},
			required: ["threadId"],
		},
	},
	{
		name: "chat_recent",
		description:
			"Retrieve recent chat threads. Shows the most recent conversations with their last message. Useful for 'what were we working on recently?' queries.",
		inputSchema: {
			type: "object" as const,
			properties: {
				limit: {
					type: "number",
					description: "Number of recent messages to return (default 10)",
				},
			},
			required: [],
		},
	},
	{
		name: "chat_log",
		description:
			"Log a message to chat history. Use this to persist conversation content for future search and retrieval. Call this for user messages, key decisions, and session boundaries.",
		inputSchema: {
			type: "object" as const,
			properties: {
				content: {
					type: "string",
					description: "The message content to log",
				},
				speaker: {
					type: "string",
					description: 'Who said it: "user", "randal", or "agent:<name>" (default: "randal")',
				},
				threadId: {
					type: "string",
					description:
						"Thread ID to associate this message with. Omit to auto-generate a new thread ID.",
				},
				scope: {
					type: "string",
					description: "Scope for this message. Omit for auto-detected project scope.",
				},
				channel: {
					type: "string",
					description: 'Channel identifier (default: "opencode")',
				},
			},
			required: ["content"],
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

	if (!(await ensureStore())) {
		const error = getStoreError();
		return { results: [], message: error, error, hint: MEILI_HINT };
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

	if (!(await ensureStore())) {
		const error = getStoreError();
		return { stored: false, message: error, error, hint: MEILI_HINT };
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

	if (!(await ensureStore())) {
		const error = getStoreError();
		return { results: [], message: error, error, hint: MEILI_HINT };
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

// ---------------------------------------------------------------------------
// Chat tool handlers — thin wrappers over MessageManager
// ---------------------------------------------------------------------------

async function handleChatSearch(params: Record<string, unknown>): Promise<unknown> {
	const query = params.query as string;
	if (!query) {
		throw new ToolError("Missing required parameter: query");
	}

	const limit = typeof params.limit === "number" ? params.limit : 10;
	const scope = params.scope as string | undefined;

	if (!(await ensureMessages())) {
		const error = getMessagesError();
		return { results: [], message: error, error, hint: MEILI_HINT };
	}

	try {
		// Search summaries first for high-signal results
		const summaryResults = await messageManager.search(query, limit, {
			...(scope ? { scope } : {}),
			type: "summary",
		});

		// Then search individual messages
		const messageResults = await messageManager.search(query, limit, {
			...(scope ? { scope } : {}),
			type: "message",
		});

		// Merge: summaries first, then messages, deduplicated by id, up to limit
		const seen = new Set<string>();
		const merged = [];

		for (const doc of [...summaryResults, ...messageResults]) {
			if (seen.has(doc.id)) continue;
			seen.add(doc.id);
			merged.push({
				id: doc.id,
				threadId: doc.threadId,
				speaker: doc.speaker,
				content: doc.content,
				timestamp: doc.timestamp,
				type: doc.type ?? "message",
				summary: doc.summary,
				topicKeywords: doc.topicKeywords,
				scope: doc.scope,
				resumeHint: `This conversation was in thread ${doc.threadId}. Use chat_thread to retrieve the full conversation.`,
			});
			if (merged.length >= limit) break;
		}

		return { results: merged };
	} catch (err) {
		log("error", `chat_search failed: ${err instanceof Error ? err.message : String(err)}`);
		return { results: [], message: "Chat search failed" };
	}
}

async function handleChatThread(params: Record<string, unknown>): Promise<unknown> {
	const threadId = params.threadId as string;
	if (!threadId) {
		throw new ToolError("Missing required parameter: threadId");
	}

	const limit = typeof params.limit === "number" ? params.limit : 50;

	if (!(await ensureMessages())) {
		const error = getMessagesError();
		return { messages: [], message: error, error, hint: MEILI_HINT };
	}

	try {
		const messages = await messageManager.thread(threadId, limit);

		return {
			threadId,
			messages: messages.map((doc) => ({
				id: doc.id,
				speaker: doc.speaker,
				content: doc.content,
				timestamp: doc.timestamp,
				type: doc.type ?? "message",
				channel: doc.channel,
			})),
		};
	} catch (err) {
		log("error", `chat_thread failed: ${err instanceof Error ? err.message : String(err)}`);
		return { messages: [], message: "Thread retrieval failed" };
	}
}

async function handleChatRecent(params: Record<string, unknown>): Promise<unknown> {
	const limit = typeof params.limit === "number" ? params.limit : 10;

	if (!(await ensureMessages())) {
		const error = getMessagesError();
		return { results: [], message: error, error, hint: MEILI_HINT };
	}

	try {
		const messages = await messageManager.recent(limit);

		return {
			results: messages.map((doc) => ({
				id: doc.id,
				threadId: doc.threadId,
				speaker: doc.speaker,
				content: doc.content,
				timestamp: doc.timestamp,
				type: doc.type ?? "message",
				channel: doc.channel,
				scope: doc.scope,
			})),
		};
	} catch (err) {
		log("error", `chat_recent failed: ${err instanceof Error ? err.message : String(err)}`);
		return { results: [], message: "Recent chat query failed" };
	}
}

async function handleChatLog(params: Record<string, unknown>): Promise<unknown> {
	const content = params.content as string;
	if (!content) {
		throw new ToolError("Missing required parameter: content");
	}

	const speaker = (params.speaker as string) || "randal";
	const threadId = (params.threadId as string) || randomUUID();
	const scope = (params.scope as string) || defaultScope;
	const channel = (params.channel as string) || "opencode";

	if (!(await ensureMessages())) {
		const error = getMessagesError();
		return { logged: false, message: error, error, hint: MEILI_HINT };
	}

	try {
		const id = await messageManager.add({
			content,
			speaker: speaker as "user" | "randal" | `agent:${string}`,
			threadId,
			channel,
			timestamp: new Date().toISOString(),
			type: "message",
			scope,
		});

		return {
			logged: true,
			id,
			threadId,
			scope,
			message: "Message logged to chat history",
		};
	} catch (err) {
		log("error", `chat_log failed: ${err instanceof Error ? err.message : String(err)}`);
		return { logged: false, message: "Chat log operation failed" };
	}
}

/** Map tool names to handlers */
const TOOL_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
	memory_search: handleMemorySearch,
	memory_store: handleMemoryStore,
	memory_recent: handleMemoryRecent,
	chat_search: handleChatSearch,
	chat_thread: handleChatThread,
	chat_recent: handleChatRecent,
	chat_log: handleChatLog,
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
				serverInfo: { name: "randal-memory", version: "0.3.0" },
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

	// Fire-and-forget: retry init in background so MCP server is immediately responsive
	retryInit();

	// Start periodic dump scheduler (works for both local and remote Meilisearch)
	startDumpScheduler();

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
