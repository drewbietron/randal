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
 *   - struggle_check  — detect stuck loops, no progress, high token burn
 *   - context_check   — read injected context from context.md
 *   - reliability_scores — query pass rates across dimensions (analytics)
 *   - recommendations — get actionable improvement suggestions (analytics)
 *   - get_feedback    — get empirical guidance for a task domain (analytics)
 *   - annotate        — submit quality annotation for a completed task (analytics)
 *   - posse_members   — discover other Randal instances in the posse (delegation)
 *   - delegate_task   — send a task to a peer instance (delegation)
 *   - posse_memory_search — search shared memory across posse peers (delegation)
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
 *   RANDAL_SKIP_MEILISEARCH — skip Docker auto-start when "true" (default: unset)
 *   ANALYTICS_ENABLED    — enable analytics tools (default: "true")
 *   RANDAL_INSTANCE_NAME — instance name for annotation index (default: "randal")
 *   RANDAL_POSSE_NAME    — posse name to join (enables delegation tools)
 *   RANDAL_SELF_NAME     — this agent's name in the posse
 *   RANDAL_GATEWAY_URL   — this agent's gateway URL (for peer identification)
 *   RANDAL_CROSS_AGENT_READ_FROM — comma-separated index names for cross-agent memory search
 *   RANDAL_PEER_AUTH_TOKEN — optional auth token for peer-to-peer HTTP calls
 */

import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	MeilisearchAnnotationStore,
	computeReliabilityScores,
	computeTrends,
	generateFeedback,
	generateRecommendations,
	getPrimaryDomain,
} from "@randal/analytics";
import type { Annotation, AnnotationVerdict, RandalConfig } from "@randal/core";
import {
	EmbeddingService,
	MeilisearchStore,
	MessageManager,
	queryPosseMembers,
	registryDocToMeshInstance,
	searchCrossAgent,
} from "@randal/memory";
import type { RegistryClient, SummaryGeneratorOptions } from "@randal/memory";
import { checkHealth, routeTask } from "@randal/mesh";
import type { RoutingContext } from "@randal/mesh";
import { checkStruggle } from "@randal/runner";
import { MeiliSearch } from "meilisearch";

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

// Channel-awareness: origin metadata injected by the runner
const RANDAL_JOB_ID = process.env.RANDAL_JOB_ID || "";
const RANDAL_CHANNEL = process.env.RANDAL_CHANNEL || "";
const RANDAL_FROM = process.env.RANDAL_FROM || "";
const RANDAL_REPLY_TO = process.env.RANDAL_REPLY_TO || "";
const RANDAL_TRIGGER = process.env.RANDAL_TRIGGER || "";
const RANDAL_BRAIN_SESSION = process.env.RANDAL_BRAIN_SESSION || "";
const RANDAL_GATEWAY_AUTH = process.env.RANDAL_GATEWAY_AUTH || "";

// Posse configuration — enables cross-instance delegation tools
const RANDAL_POSSE_NAME = process.env.RANDAL_POSSE_NAME || "";
const RANDAL_SELF_NAME = process.env.RANDAL_SELF_NAME || "";
const RANDAL_GATEWAY_URL = process.env.RANDAL_GATEWAY_URL || "";
const RANDAL_CROSS_AGENT_READ_FROM = process.env.RANDAL_CROSS_AGENT_READ_FROM || "";
const RANDAL_PEER_AUTH_TOKEN = process.env.RANDAL_PEER_AUTH_TOKEN || "";

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

const embeddingService = OPENROUTER_API_KEY
	? new EmbeddingService({
			apiKey: OPENROUTER_API_KEY,
			model: EMBEDDING_MODEL,
			url: EMBEDDING_URL,
		})
	: undefined;

const store = new MeilisearchStore({
	url: MEILI_URL,
	apiKey: MEILI_MASTER_KEY,
	index: MEILI_INDEX,
	embeddingService,
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
	embeddingService,
	semanticRatio: Number.isFinite(SEMANTIC_RATIO) ? SEMANTIC_RATIO : 0.7,
	summaryGenerator: summaryGeneratorConfig,
});

/** Whether the message manager initialized successfully. */
let messagesAvailable = false;

/** Last init failure reason for diagnostics (null = no error). */
let messagesInitError: string | null = null;

// ---------------------------------------------------------------------------
// Analytics store construction
// ---------------------------------------------------------------------------

const ANALYTICS_ENABLED = process.env.ANALYTICS_ENABLED !== "false";
const INSTANCE_NAME = process.env.RANDAL_INSTANCE_NAME || "randal";

const meiliClient = new MeiliSearch({ host: MEILI_URL, apiKey: MEILI_MASTER_KEY || undefined });
const annotationStore = new MeilisearchAnnotationStore(meiliClient, INSTANCE_NAME);

/** Whether the annotation store initialized successfully. */
let analyticsAvailable = false;

/** Last init failure reason for diagnostics (null = no error). */
let analyticsInitError: string | null = null;

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
	if (ANALYTICS_ENABLED) {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				await annotationStore.init();
				analyticsAvailable = true;
				analyticsInitError = null;
				log("info", `AnnotationStore initialized (attempt ${attempt})`);
				break;
			} catch (err) {
				analyticsInitError = classifyInitError(err);
				const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
				log(
					"warn",
					`AnnotationStore init attempt ${attempt}/${MAX_ATTEMPTS} failed: ${analyticsInitError}. Retry in ${delay}ms`,
				);
				if (attempt < MAX_ATTEMPTS) await Bun.sleep(delay);
			}
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

/** Lazy re-init: attempt annotationStore.init() if not yet available. Returns true if available. */
async function ensureAnalytics(): Promise<boolean> {
	if (!ANALYTICS_ENABLED) return false;
	if (analyticsAvailable) return true;
	try {
		await annotationStore.init();
		analyticsAvailable = true;
		analyticsInitError = null;
		log("info", "AnnotationStore lazy re-init succeeded");
		return true;
	} catch (err) {
		analyticsInitError = classifyInitError(err);
		return false;
	}
}

/**
 * Check if posse is configured and the Meilisearch client is ready.
 * Returns true if posse_members/delegate_task/posse_memory_search tools can operate.
 */
function ensurePosse(): boolean {
	return !!(RANDAL_POSSE_NAME && RANDAL_SELF_NAME);
}

/**
 * Build a minimal RandalConfig stub with the fields needed for posse operations.
 * This avoids importing the full parseConfig() just for the MCP server.
 */
function buildPosseConfigStub(): RandalConfig {
	return {
		posse: RANDAL_POSSE_NAME,
		name: RANDAL_SELF_NAME,
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
		mesh: {
			endpoint: RANDAL_GATEWAY_URL,
		},
		// Minimal stubs for required fields — not used by posse operations
		tools: [],
		runner: { defaultAgent: "" },
		version: "0.1",
	} as unknown as RandalConfig;
}

/** Get a diagnostic error string for store unavailability. */
function getStoreError(): string {
	return storeInitError ?? "Meilisearch is not available (unknown reason)";
}

/** Get a diagnostic error string for messages unavailability. */
function getMessagesError(): string {
	return messagesInitError ?? "Chat history is not available (unknown reason)";
}

/** Get a diagnostic error string for analytics unavailability. */
function getAnalyticsError(): string {
	if (!ANALYTICS_ENABLED) return "Analytics not enabled (set ANALYTICS_ENABLED=true)";
	return analyticsInitError ?? "Annotation store is not available (unknown reason)";
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
// Meilisearch auto-start (Docker container)
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-start the Meilisearch Docker container if it isn't running.
 * Called before retryInit() to handle the common case of a stopped container.
 * Never throws — logs warnings and returns on any failure.
 */
async function tryStartMeilisearch(): Promise<void> {
	// 1. Check RANDAL_SKIP_MEILISEARCH env var
	if (process.env.RANDAL_SKIP_MEILISEARCH === "true") {
		log("info", "Meilisearch auto-start skipped (RANDAL_SKIP_MEILISEARCH=true)");
		return;
	}

	// 2. Health check — if already healthy, return immediately
	try {
		const resp = await fetch(`${MEILI_URL}/health`, { signal: AbortSignal.timeout(3000) });
		if (resp.ok) {
			log("info", "Meilisearch already healthy — skipping auto-start");
			return;
		}
	} catch {
		// Not reachable — continue to auto-start attempt
	}

	// 3. Attempt docker start
	log("info", "Meilisearch not reachable — attempting docker start randal-meili");
	try {
		execSync("docker start randal-meili", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
		});
		log("info", "docker start randal-meili succeeded — waiting for healthy");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("No such container")) {
			log(
				"warn",
				"Container randal-meili does not exist — skipping auto-start. Run scripts/meili-start.sh to create it.",
			);
		} else if (
			msg.includes("ENOENT") ||
			msg.includes("not found") ||
			msg.includes("command not found")
		) {
			log("warn", "Docker not available — skipping Meilisearch auto-start");
		} else {
			log("warn", `docker start failed: ${msg} — skipping auto-start`);
		}
		return;
	}

	// 4. Poll health endpoint up to 10 times (1s apart)
	for (let i = 1; i <= 10; i++) {
		await Bun.sleep(1000);
		try {
			const resp = await fetch(`${MEILI_URL}/health`, { signal: AbortSignal.timeout(2000) });
			if (resp.ok) {
				log("info", `Meilisearch healthy after ${i}s`);
				return;
			}
		} catch {
			// Not yet ready — continue polling
		}
		if (i < 10) {
			log("info", `Waiting for Meilisearch... (${i}/10)`);
		}
	}

	log(
		"warn",
		"Meilisearch did not become healthy within 10s after docker start — retryInit will handle backoff",
	);
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
	// --- Struggle detection tool ---
	{
		name: "struggle_check",
		description:
			"Check if the current work session shows signs of struggle (stuck loops, no progress, high token burn). Call this during self-monitoring to detect when you need to change approach. Does not require Meilisearch — pure logic.",
		inputSchema: {
			type: "object" as const,
			properties: {
				iterations_without_progress: {
					type: "number",
					description:
						"Number of recent iterations/attempts that produced no meaningful file changes",
				},
				recent_errors: {
					type: "number",
					description: "Number of consecutive errors or non-zero exit codes in recent attempts",
				},
				identical_output_count: {
					type: "number",
					description:
						"Number of consecutive attempts that produced identical or near-identical output",
				},
				token_burn_ratio: {
					type: "number",
					description:
						"Ratio of recent token usage to average. >1.5 indicates high burn without progress. Pass 1.0 if unknown.",
				},
			},
			required: ["iterations_without_progress", "recent_errors"],
		},
	},
	// --- Context injection check tool ---
	{
		name: "context_check",
		description:
			"Check for injected context from channels or the user. Returns any pending context from context.md in the working directory. The file is deleted after reading. Call this periodically during long-running tasks to pick up mid-session context injections (e.g., user sends a follow-up message via Discord while a build is running).",
		inputSchema: {
			type: "object" as const,
			properties: {
				workdir: {
					type: "string",
					description: "Working directory to check. Defaults to the current working directory.",
				},
			},
			required: [],
		},
	},
	// --- Analytics tools ---
	{
		name: "reliability_scores",
		description:
			"Query the brain's own pass rates across dimensions (overall, agent, model, domain, complexity). Returns scores + 7-day/30-day trends. Use this to understand your reliability before starting work.",
		inputSchema: {
			type: "object" as const,
			properties: {
				dimension: {
					type: "string",
					description:
						'Optional dimension filter: "overall", "agent", "model", "domain", or "complexity". Returns all dimensions if omitted.',
				},
				agingHalfLife: {
					type: "number",
					description:
						"Half-life for annotation aging in days (default: 30). Recent annotations weigh more.",
				},
			},
			required: [],
		},
	},
	{
		name: "recommendations",
		description:
			'Ask "what should I improve?" Returns actionable recommendations: model switches, knowledge gaps, instance splitting, trend alerts.',
		inputSchema: {
			type: "object" as const,
			properties: {},
			required: [],
		},
	},
	{
		name: "get_feedback",
		description:
			"Get empirical guidance text for a given task domain based on past annotation patterns. Returns a markdown block suitable for injection into build context.",
		inputSchema: {
			type: "object" as const,
			properties: {
				domain: {
					type: "string",
					description:
						'Task domain to get feedback for (e.g., "frontend", "backend", "database", "infra", "docs", "testing").',
				},
			},
			required: ["domain"],
		},
	},
	{
		name: "annotate",
		description:
			"Submit a quality annotation for a completed task. Used to track agent reliability and feed the self-learning analytics loop.",
		inputSchema: {
			type: "object" as const,
			properties: {
				jobId: {
					type: "string",
					description: "Job ID or plan slug to annotate",
				},
				verdict: {
					type: "string",
					description: 'Annotation verdict: "pass", "fail", or "partial"',
				},
				feedback: {
					type: "string",
					description: "Optional feedback text describing what went well or wrong",
				},
				categories: {
					type: "array",
					description: "Optional category tags for the annotation",
				},
				agent: {
					type: "string",
					description: 'Agent name (default: "opencode")',
				},
				model: {
					type: "string",
					description: 'Model used (default: "unknown")',
				},
				prompt: {
					type: "string",
					description: "Original task prompt (used for domain auto-detection)",
				},
				domain: {
					type: "string",
					description: "Task domain. Auto-detected from prompt if omitted.",
				},
				iterationCount: {
					type: "number",
					description: "Number of iterations/attempts (default: 1)",
				},
				tokenCost: {
					type: "number",
					description: "Estimated token cost (default: 0)",
				},
				duration: {
					type: "number",
					description: "Wall time in seconds (default: 0)",
				},
				filesChanged: {
					type: "array",
					description: "List of files changed during the task",
				},
			},
			required: ["jobId", "verdict"],
		},
	},
	// --- Posse delegation tools ---
	{
		name: "posse_members",
		description:
			"Discover other Randal instances in your posse. Returns name, status, specialization, capabilities, endpoint, and last heartbeat for each member. Use this to see who is available before delegating work.",
		inputSchema: {
			type: "object" as const,
			properties: {},
			required: [],
		},
	},
	{
		name: "delegate_task",
		description:
			"Send a task to another Randal instance in the posse. Specify a target peer by name, or omit to auto-route to the best-fit instance. Returns the job ID and result (or polls until complete).",
		inputSchema: {
			type: "object" as const,
			properties: {
				task: {
					type: "string",
					description: "The task description to delegate",
				},
				target: {
					type: "string",
					description: "Name of the target peer (from posse_members). Omit for auto-routing.",
				},
				domain: {
					type: "string",
					description: "Task domain hint for auto-routing (e.g. 'frontend', 'backend', 'devops')",
				},
				model: {
					type: "string",
					description: "Preferred model for the task (used in auto-routing scoring)",
				},
				async: {
					type: "boolean",
					description:
						"If true, return immediately with the job ID instead of waiting for completion (default: false)",
				},
			},
			required: ["task"],
		},
	},
	{
		name: "posse_memory_search",
		description:
			"Search shared posse memory across other Randal instances. Returns learnings, patterns, and facts from peers. Useful for checking if another instance already solved a similar problem.",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "Search query for cross-agent memory",
				},
				limit: {
					type: "number",
					description: "Maximum number of results to return (default 5)",
				},
			},
			required: ["query"],
		},
	},
	// ---- Channel Awareness Tools ----
	{
		name: "job_info",
		description:
			"Get metadata about the current job: job ID, channel, sender, reply-to address, and trigger type. " +
			"Use this to adapt behavior based on context — e.g., shorter responses for Discord, " +
			"knowing if this is a user request vs a scheduled task. Returns empty/default values in interactive mode (no channel).",
		inputSchema: {
			type: "object" as const,
			properties: {},
			required: [],
		},
	},
	{
		name: "channel_list",
		description:
			"List connected communication channels and their capabilities. " +
			"Returns an array of channels (e.g., discord, imessage) with whether they support sending messages. " +
			"Use this to discover where you can send messages. Returns empty list in interactive mode.",
		inputSchema: {
			type: "object" as const,
			properties: {},
			required: [],
		},
	},
	{
		name: "channel_send",
		description:
			"Send a message to a specific channel and target. The target depends on the channel type: " +
			"for Discord it's a channel/thread ID, for iMessage it's a chat GUID. " +
			"Use job_info to get the current channel and replyTo target for responding in the same conversation. " +
			"The message will go through the channel adapter's formatting and rate limiting.",
		inputSchema: {
			type: "object" as const,
			properties: {
				channel: {
					type: "string",
					description: 'Channel name: "discord", "imessage", etc.',
				},
				target: {
					type: "string",
					description:
						"Target identifier within the channel (Discord channel/thread ID, iMessage chat GUID, etc.)",
				},
				message: {
					type: "string",
					description: "Message text to send",
				},
			},
			required: ["channel", "target", "message"],
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

// ---------------------------------------------------------------------------
// Struggle detection + context check handlers — pure logic, no Meilisearch
// ---------------------------------------------------------------------------

async function handleStruggleCheck(params: Record<string, unknown>): Promise<unknown> {
	return checkStruggle({
		iterations_without_progress: (params.iterations_without_progress as number) ?? 0,
		recent_errors: (params.recent_errors as number) ?? 0,
		identical_output_count: (params.identical_output_count as number) ?? 0,
		token_burn_ratio: (params.token_burn_ratio as number) ?? 1.0,
	});
}

async function handleContextCheck(params: Record<string, unknown>): Promise<unknown> {
	const workdir = (params.workdir as string) || process.cwd();
	const contextPath = join(workdir, "context.md");

	try {
		if (!existsSync(contextPath)) {
			return { hasContext: false, content: null };
		}

		const content = readFileSync(contextPath, "utf-8").trim();
		if (!content) {
			return { hasContext: false, content: null };
		}

		// Delete after reading (atomic read-and-clear)
		try {
			unlinkSync(contextPath);
		} catch {
			/* ok — file may have been deleted between read and unlink */
		}

		return { hasContext: true, content };
	} catch {
		return { hasContext: false, content: null };
	}
}

// ---------------------------------------------------------------------------
// Analytics tool handlers
// ---------------------------------------------------------------------------

/** Shared helper: fetch annotations and compute scores to avoid redundant work. */
async function getAnnotationsAndScores(agingHalfLife?: number) {
	const annotations = await annotationStore.list();
	const { scores, insufficientData } = computeReliabilityScores(annotations, {
		agingHalfLife,
	});
	return { annotations, scores, insufficientData };
}

async function handleReliabilityScores(params: Record<string, unknown>): Promise<unknown> {
	if (!ANALYTICS_ENABLED) {
		return {
			message: "Analytics not enabled",
			scores: [],
			trends: { sevenDay: null, thirtyDay: null },
			insufficientData: true,
		};
	}
	if (!(await ensureAnalytics())) {
		const error = getAnalyticsError();
		return {
			scores: [],
			trends: { sevenDay: null, thirtyDay: null },
			insufficientData: true,
			message: error,
			error,
			hint: MEILI_HINT,
		};
	}

	try {
		const dimension = params.dimension as string | undefined;
		const agingHalfLife =
			typeof params.agingHalfLife === "number" ? params.agingHalfLife : undefined;

		const { annotations, scores, insufficientData } = await getAnnotationsAndScores(agingHalfLife);
		const trends = computeTrends(annotations);

		const filteredScores = dimension ? scores.filter((s) => s.dimension === dimension) : scores;

		return {
			scores: filteredScores,
			trends,
			insufficientData,
			totalAnnotations: annotations.length,
		};
	} catch (err) {
		log("error", `reliability_scores failed: ${err instanceof Error ? err.message : String(err)}`);
		return {
			scores: [],
			trends: { sevenDay: null, thirtyDay: null },
			insufficientData: true,
			message: "Failed to compute scores",
		};
	}
}

async function handleRecommendations(_params: Record<string, unknown>): Promise<unknown> {
	if (!ANALYTICS_ENABLED) {
		return { message: "Analytics not enabled", recommendations: [] };
	}
	if (!(await ensureAnalytics())) {
		const error = getAnalyticsError();
		return { recommendations: [], message: error, error, hint: MEILI_HINT };
	}

	try {
		const { annotations, scores } = await getAnnotationsAndScores();
		const recommendations = generateRecommendations(scores, annotations);

		return { recommendations };
	} catch (err) {
		log("error", `recommendations failed: ${err instanceof Error ? err.message : String(err)}`);
		return { recommendations: [], message: "Failed to generate recommendations" };
	}
}

async function handleGetFeedback(params: Record<string, unknown>): Promise<unknown> {
	const domain = params.domain as string;
	if (!domain) {
		throw new ToolError("Missing required parameter: domain");
	}

	if (!ANALYTICS_ENABLED) {
		return { message: "Analytics not enabled", feedback: "", domain };
	}
	if (!(await ensureAnalytics())) {
		const error = getAnalyticsError();
		return { feedback: "", domain, message: error, error, hint: MEILI_HINT };
	}

	try {
		const { annotations, scores } = await getAnnotationsAndScores();
		const feedback = generateFeedback(scores, annotations, domain);

		return { feedback, domain };
	} catch (err) {
		log("error", `get_feedback failed: ${err instanceof Error ? err.message : String(err)}`);
		return { feedback: "", domain, message: "Failed to generate feedback" };
	}
}

async function handleAnnotate(params: Record<string, unknown>): Promise<unknown> {
	const jobId = params.jobId as string;
	const verdict = params.verdict as string;

	if (!jobId) {
		throw new ToolError("Missing required parameter: jobId");
	}
	if (!verdict || !["pass", "fail", "partial"].includes(verdict)) {
		throw new ToolError(
			'Missing or invalid parameter: verdict (must be "pass", "fail", or "partial")',
		);
	}

	if (!ANALYTICS_ENABLED) {
		return { success: false, message: "Analytics not enabled" };
	}
	if (!(await ensureAnalytics())) {
		const error = getAnalyticsError();
		return { success: false, message: error, error, hint: MEILI_HINT };
	}

	try {
		const prompt = (params.prompt as string) || "";
		const domain = (params.domain as string) || (prompt ? getPrimaryDomain(prompt) : "general");

		const annotation: Annotation = {
			id: randomUUID(),
			jobId,
			verdict: verdict as AnnotationVerdict,
			feedback: (params.feedback as string) || undefined,
			categories: (params.categories as string[]) || undefined,
			agent: (params.agent as string) || "opencode",
			model: (params.model as string) || "unknown",
			domain,
			iterationCount: typeof params.iterationCount === "number" ? params.iterationCount : 1,
			tokenCost: typeof params.tokenCost === "number" ? params.tokenCost : 0,
			duration: typeof params.duration === "number" ? params.duration : 0,
			filesChanged: (params.filesChanged as string[]) || [],
			prompt,
			timestamp: new Date().toISOString(),
		};

		await annotationStore.save(annotation);

		return {
			success: true,
			annotationId: annotation.id,
			domain,
			message: "Annotation saved successfully",
		};
	} catch (err) {
		log("error", `annotate failed: ${err instanceof Error ? err.message : String(err)}`);
		return { success: false, message: "Failed to save annotation" };
	}
}

// ---------------------------------------------------------------------------
// Posse delegation tool handlers
// ---------------------------------------------------------------------------

const POSSE_NOT_CONFIGURED =
	"Posse not configured. Set RANDAL_POSSE_NAME and RANDAL_SELF_NAME environment variables to enable posse tools.";

async function handlePosseMembers(_params: Record<string, unknown>): Promise<unknown> {
	if (!ensurePosse()) {
		return { members: [], message: POSSE_NOT_CONFIGURED };
	}

	try {
		const config = buildPosseConfigStub();
		const posseClient = new MeiliSearch({
			host: MEILI_URL,
			apiKey: MEILI_MASTER_KEY || undefined,
		}) as unknown as RegistryClient;
		const docs = await queryPosseMembers(config, posseClient);

		return {
			members: docs.map((doc) => ({
				name: doc.name,
				status: doc.status,
				specialization: doc.specialization,
				capabilities: doc.capabilities,
				endpoint: doc.endpoint,
				lastHeartbeat: doc.lastHeartbeat,
				isSelf: doc.name === RANDAL_SELF_NAME,
			})),
		};
	} catch (err) {
		log("error", `posse_members failed: ${err instanceof Error ? err.message : String(err)}`);
		return { members: [], message: "Failed to query posse members" };
	}
}

/** Maximum time to poll for a delegated job to complete (5 minutes). */
const DELEGATE_POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** Interval between job status polls (3 seconds). */
const DELEGATE_POLL_INTERVAL_MS = 3000;
/** HTTP request timeout for delegation calls (30 seconds). */
const DELEGATE_HTTP_TIMEOUT_MS = 30_000;

async function handleDelegateTask(params: Record<string, unknown>): Promise<unknown> {
	const task = params.task as string;
	if (!task) {
		throw new ToolError("Missing required parameter: task");
	}

	if (!ensurePosse()) {
		return { delegated: false, message: POSSE_NOT_CONFIGURED };
	}

	const target = params.target as string | undefined;
	const domain = params.domain as string | undefined;
	const model = params.model as string | undefined;
	const isAsync = params.async === true;

	// Guard: reject self-delegation
	if (target && target === RANDAL_SELF_NAME) {
		return { delegated: false, message: "Cannot delegate to self" };
	}

	try {
		const config = buildPosseConfigStub();
		const posseClient = new MeiliSearch({
			host: MEILI_URL,
			apiKey: MEILI_MASTER_KEY || undefined,
		}) as unknown as RegistryClient;
		const docs = await queryPosseMembers(config, posseClient);

		// Filter out self
		const peers = docs.filter((d) => d.name !== RANDAL_SELF_NAME);
		if (peers.length === 0) {
			return { delegated: false, message: "No peers available in the posse" };
		}

		let targetEndpoint: string | undefined;
		let targetName: string | undefined;

		if (target) {
			// Explicit target — find by name
			const peer = peers.find((d) => d.name === target);
			if (!peer) {
				return {
					delegated: false,
					message: `Peer "${target}" not found in posse. Available: ${peers.map((p) => p.name).join(", ")}`,
				};
			}
			if (!peer.endpoint) {
				return {
					delegated: false,
					message: `Peer "${target}" has no endpoint registered`,
				};
			}
			targetEndpoint = peer.endpoint;
			targetName = peer.name;
		} else {
			// Auto-route using mesh router
			const instances = peers.map(registryDocToMeshInstance);
			const routingContext: RoutingContext = {
				prompt: task,
				domain,
				model,
			};
			const decision = routeTask(instances, routingContext);
			if (!decision) {
				return {
					delegated: false,
					message: "No suitable peer found for auto-routing. Consider specifying a target.",
				};
			}
			if (!decision.instance.endpoint) {
				return {
					delegated: false,
					message: `Best peer "${decision.instance.name}" has no endpoint registered`,
				};
			}
			targetEndpoint = decision.instance.endpoint;
			targetName = decision.instance.name;
			log(
				"info",
				`Auto-routed to ${targetName} (score: ${decision.score.toFixed(2)}, reason: ${decision.reason})`,
			);
		}

		// Pre-flight health check
		const healthResult = await checkHealth({
			instanceId: targetName,
			name: targetName,
			endpoint: targetEndpoint,
			status: "idle",
			capabilities: [],
			lastHeartbeat: new Date().toISOString(),
			models: [],
			activeJobs: 0,
			completedJobs: 0,
			health: { uptime: 0, missedPings: 0 },
		});

		if (!healthResult.healthy) {
			return {
				delegated: false,
				message: `Peer "${targetName}" is not healthy: ${healthResult.error ?? "unknown error"}`,
			};
		}

		// POST to peer's /jobs endpoint
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (RANDAL_PEER_AUTH_TOKEN) {
			headers.Authorization = `Bearer ${RANDAL_PEER_AUTH_TOKEN}`;
		}

		const jobResp = await fetch(`${targetEndpoint}/jobs`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				prompt: task,
				origin: {
					channel: "posse",
					from: RANDAL_SELF_NAME,
				},
			}),
			signal: AbortSignal.timeout(DELEGATE_HTTP_TIMEOUT_MS),
		});

		if (!jobResp.ok) {
			const body = await jobResp.text().catch(() => "");
			return {
				delegated: false,
				message: `Peer "${targetName}" rejected the job: HTTP ${jobResp.status} ${body}`,
			};
		}

		const jobData = (await jobResp.json()) as { id?: string; jobId?: string };
		const jobId = jobData.id ?? jobData.jobId;
		if (!jobId) {
			return {
				delegated: false,
				message: `Peer "${targetName}" returned no job ID`,
			};
		}

		log("info", `Task delegated to ${targetName}: jobId=${jobId}`);

		// If async, return immediately
		if (isAsync) {
			return {
				delegated: true,
				jobId,
				target: targetName,
				status: "submitted",
				message: `Task submitted to ${targetName}. Check status at ${targetEndpoint}/jobs/${jobId}`,
			};
		}

		// Poll for completion
		const deadline = Date.now() + DELEGATE_POLL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, DELEGATE_POLL_INTERVAL_MS));

			try {
				const statusResp = await fetch(`${targetEndpoint}/jobs/${jobId}`, {
					headers,
					signal: AbortSignal.timeout(DELEGATE_HTTP_TIMEOUT_MS),
				});

				if (!statusResp.ok) continue;

				const statusData = (await statusResp.json()) as {
					status?: string;
					summary?: string;
					error?: string;
					filesChanged?: string[];
				};

				if (
					statusData.status === "completed" ||
					statusData.status === "failed" ||
					statusData.status === "stopped"
				) {
					return {
						delegated: true,
						jobId,
						target: targetName,
						status: statusData.status,
						summary: statusData.summary ?? "",
						error: statusData.error,
						filesChanged: statusData.filesChanged ?? [],
					};
				}
			} catch {
				// Poll failure — retry
			}
		}

		return {
			delegated: true,
			jobId,
			target: targetName,
			status: "timeout",
			message: `Job ${jobId} on ${targetName} did not complete within ${DELEGATE_POLL_TIMEOUT_MS / 1000}s. Check status manually.`,
		};
	} catch (err) {
		log("error", `delegate_task failed: ${err instanceof Error ? err.message : String(err)}`);
		return {
			delegated: false,
			message: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

async function handlePosseMemorySearch(params: Record<string, unknown>): Promise<unknown> {
	const query = params.query as string;
	if (!query) {
		throw new ToolError("Missing required parameter: query");
	}

	if (!ensurePosse()) {
		return { results: [], message: POSSE_NOT_CONFIGURED };
	}

	const config = buildPosseConfigStub();
	const readFrom = config.memory.sharing.readFrom;
	if (readFrom.length === 0) {
		return {
			results: [],
			message:
				"No cross-agent indexes configured. Set RANDAL_CROSS_AGENT_READ_FROM (comma-separated index names).",
		};
	}

	const limit = typeof params.limit === "number" ? params.limit : 5;

	try {
		const docs = await searchCrossAgent(query, config, limit);

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
		log("error", `posse_memory_search failed: ${err instanceof Error ? err.message : String(err)}`);
		return { results: [], message: "Cross-agent memory search failed" };
	}
}

// ---------------------------------------------------------------------------
// Channel-awareness tool handlers
// ---------------------------------------------------------------------------

async function handleJobInfo(_params: Record<string, unknown>): Promise<unknown> {
	return {
		jobId: RANDAL_JOB_ID || null,
		channel: RANDAL_CHANNEL || null,
		from: RANDAL_FROM || null,
		replyTo: RANDAL_REPLY_TO || null,
		triggerType: RANDAL_TRIGGER || "user",
		isBrainSession: RANDAL_BRAIN_SESSION === "true",
		isInteractive: !RANDAL_CHANNEL,
		gatewayAvailable: !!RANDAL_GATEWAY_URL,
	};
}

/**
 * Call the gateway internal API.
 * Returns the parsed JSON response or throws on failure.
 */
async function gatewayFetch(path: string, options?: RequestInit): Promise<unknown> {
	if (!RANDAL_GATEWAY_URL) {
		throw new ToolError("Gateway URL not available (not running in a gateway-managed session)");
	}
	const url = `${RANDAL_GATEWAY_URL}${path}`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(RANDAL_GATEWAY_AUTH && { Authorization: `Bearer ${RANDAL_GATEWAY_AUTH}` }),
	};
	const resp = await fetch(url, {
		...options,
		headers: { ...headers, ...(options?.headers as Record<string, string>) },
	});
	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new ToolError(`Gateway API error ${resp.status}: ${body}`);
	}
	return resp.json();
}

async function handleChannelList(_params: Record<string, unknown>): Promise<unknown> {
	if (!RANDAL_GATEWAY_URL) {
		return { channels: [], message: "No gateway connection (interactive mode)" };
	}
	try {
		return await gatewayFetch("/_internal/channels");
	} catch (err) {
		return {
			channels: [],
			message: err instanceof Error ? err.message : "Failed to query channels",
		};
	}
}

async function handleChannelSend(params: Record<string, unknown>): Promise<unknown> {
	const channel = params.channel as string;
	const target = params.target as string;
	const message = params.message as string;

	if (!channel) throw new ToolError("Missing required parameter: channel");
	if (!target) throw new ToolError("Missing required parameter: target");
	if (!message) throw new ToolError("Missing required parameter: message");

	if (!RANDAL_GATEWAY_URL) {
		return { sent: false, message: "No gateway connection (interactive mode)" };
	}

	try {
		const result = await gatewayFetch("/_internal/channel/send", {
			method: "POST",
			body: JSON.stringify({ channel, target, message }),
		});
		return { sent: true, ...(result as object) };
	} catch (err) {
		return {
			sent: false,
			message: err instanceof Error ? err.message : "Send failed",
		};
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
	struggle_check: handleStruggleCheck,
	context_check: handleContextCheck,
	reliability_scores: handleReliabilityScores,
	recommendations: handleRecommendations,
	get_feedback: handleGetFeedback,
	annotate: handleAnnotate,
	posse_members: handlePosseMembers,
	delegate_task: handleDelegateTask,
	posse_memory_search: handlePosseMemorySearch,
	job_info: handleJobInfo,
	channel_list: handleChannelList,
	channel_send: handleChannelSend,
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

	// Attempt to auto-start Meilisearch Docker container if not running
	await tryStartMeilisearch();

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
