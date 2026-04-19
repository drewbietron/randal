/**
 * Chat history tool handlers: search, thread, recent, log.
 *
 * Thin wrappers over MessageManager, with lazy init via ensure guards.
 */

import { randomUUID } from "node:crypto";
import { ToolError, log } from "../../lib/mcp-transport.js";
import type { ToolDefinition, ToolHandler } from "../../lib/mcp-transport.js";
import { ensureMessages, getMessagesError, messageManager } from "../init.js";
import { MEILI_HINT, defaultScope, sessionHasGrant } from "../types.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
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
// Handlers
// ---------------------------------------------------------------------------

async function handleChatSearch(params: Record<string, unknown>): Promise<unknown> {
	if (!sessionHasGrant("chat")) {
		return { results: [], message: "Voice session is not allowed to use chat tools" };
	}

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
	if (!sessionHasGrant("chat")) {
		return { messages: [], message: "Voice session is not allowed to use chat tools" };
	}

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
	if (!sessionHasGrant("chat")) {
		return { results: [], message: "Voice session is not allowed to use chat tools" };
	}

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
	if (!sessionHasGrant("chat")) {
		return { logged: false, message: "Voice session is not allowed to use chat tools" };
	}

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
// Registration
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, ToolHandler> = {
	chat_search: handleChatSearch,
	chat_thread: handleChatThread,
	chat_recent: handleChatRecent,
	chat_log: handleChatLog,
};

/**
 * Register chat history tool definitions and handlers.
 * Returns { definitions, handlers } for the entrypoint to merge.
 */
export function registerChatHandlers() {
	return { definitions: TOOL_DEFINITIONS, handlers: HANDLERS };
}
