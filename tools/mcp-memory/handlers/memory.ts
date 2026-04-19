/**
 * Memory CRUD tool handlers: search, store, recent.
 *
 * Thin wrappers over MeilisearchStore, with lazy init via ensure guards.
 */

import { createHash } from "node:crypto";
import { ToolError, log } from "../../lib/mcp-transport.js";
import type { ToolDefinition, ToolHandler } from "../../lib/mcp-transport.js";
import { ensureStore, getStoreError, store } from "../init.js";
import { MEILI_HINT, resolveSearchScope, resolveStoreScope, sessionHasGrant } from "../types.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
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
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleMemorySearch(params: Record<string, unknown>): Promise<unknown> {
	if (!sessionHasGrant("memory")) {
		return { results: [], message: "Voice session is not allowed to use memory tools" };
	}

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
	if (!sessionHasGrant("memory")) {
		return { stored: false, message: "Voice session is not allowed to use memory tools" };
	}

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
	if (!sessionHasGrant("memory")) {
		return { results: [], message: "Voice session is not allowed to use memory tools" };
	}

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
// Registration
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, ToolHandler> = {
	memory_search: handleMemorySearch,
	memory_store: handleMemoryStore,
	memory_recent: handleMemoryRecent,
};

/**
 * Register memory tool definitions and handlers.
 * Returns { definitions, handlers } for the entrypoint to merge.
 */
export function registerMemoryHandlers() {
	return { definitions: TOOL_DEFINITIONS, handlers: HANDLERS };
}
