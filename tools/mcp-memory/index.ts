#!/usr/bin/env bun
/**
 * MCP memory server entrypoint.
 *
 * Thin wiring layer that imports handler modules and starts the shared
 * JSON-RPC stdio transport. All logic lives in handler modules under ./handlers/.
 */

import type { ToolDefinition, ToolHandler } from "../lib/mcp-transport.js";
import { startMcpServer } from "../lib/mcp-transport.js";
import { startDumpScheduler, tryStartMeilisearch } from "./docker.js";
import { registerAnalyticsHandlers } from "./handlers/analytics.js";
import { registerChannelHandlers } from "./handlers/channels.js";
import { registerChatHandlers } from "./handlers/chat.js";
import { registerMemoryHandlers } from "./handlers/memory.js";
import { registerPosseHandlers } from "./handlers/posse.js";
import { retryInit } from "./init.js";
import { MEILI_INDEX, defaultScope } from "./types.js";

// ---------------------------------------------------------------------------
// Collect all tool definitions and handlers from modules
// ---------------------------------------------------------------------------

const allDefinitions: ToolDefinition[] = [];
const allHandlers: Record<string, ToolHandler> = {};

for (const register of [
	registerMemoryHandlers,
	registerChatHandlers,
	registerAnalyticsHandlers,
	registerPosseHandlers,
	registerChannelHandlers,
]) {
	const { definitions, handlers } = register();
	allDefinitions.push(...definitions);
	Object.assign(allHandlers, handlers);
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

startMcpServer({
	serverName: `randal-memory (index: ${MEILI_INDEX}, scope: ${defaultScope})`,
	serverVersion: "0.3.0",
	tools: allDefinitions,
	handlers: allHandlers,
	async onStart() {
		// Attempt to auto-start Meilisearch Docker container if not running
		await tryStartMeilisearch();

		// Fire-and-forget: retry init in background so MCP server is immediately responsive
		retryInit();

		// Start periodic dump scheduler (works for both local and remote Meilisearch)
		startDumpScheduler();
	},
});
