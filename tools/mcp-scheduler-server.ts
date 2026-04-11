#!/usr/bin/env bun
/**
 * Standalone MCP stdio server for scheduler awareness.
 *
 * Provides the brain with visibility into the scheduling system via three tools:
 *   - schedule_info   — query current scheduler state (heartbeat, cron, hooks)
 *   - schedule_cron   — add, remove, or list cron jobs
 *   - wake_heartbeat  — queue a wake item for the next heartbeat tick
 *
 * Communication: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 * Connects to the gateway HTTP API — requires the gateway to be running.
 *
 * Environment variables:
 *   RANDAL_GATEWAY_URL   — Gateway URL (default: http://localhost:7600)
 *   RANDAL_GATEWAY_TOKEN — Auth token for gateway API
 */

import { ToolError, startMcpServer } from "./lib/mcp-transport.js";
import type { ToolDefinition, ToolHandler } from "./lib/mcp-transport.js";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const GATEWAY_URL = process.env.RANDAL_GATEWAY_URL || "http://localhost:7600";
const GATEWAY_TOKEN = process.env.RANDAL_GATEWAY_TOKEN || "";

// ---------------------------------------------------------------------------
// MCP tool schema definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "schedule_info",
		description:
			"Query the current scheduler state: heartbeat config (interval, active hours, tick count, pending wake items), cron jobs (name, schedule, last/next run), and hooks status. Returns a structured overview of the scheduling system.",
		inputSchema: {
			type: "object" as const,
			properties: {},
			required: [] as string[],
		},
	},
	{
		name: "schedule_cron",
		description:
			'Manage cron jobs: list all jobs, add a new job, or remove an existing job. Use action "list" to see all jobs, "add" to create a new scheduled task, or "remove" to delete one.',
		inputSchema: {
			type: "object" as const,
			properties: {
				action: {
					type: "string",
					enum: ["list", "add", "remove"],
					description: 'Action to perform: "list", "add", or "remove"',
				},
				name: {
					type: "string",
					description: "Job name (required for add and remove)",
				},
				schedule: {
					description:
						'Cron schedule. String for cron expressions (e.g. "0 9 * * 1-5"), object { every: "30m" } for intervals, or object { at: "2026-04-08T10:00:00Z" } for one-shot.',
				},
				prompt: {
					type: "string",
					description: "Prompt/task for the brain to execute when the job fires",
				},
				execution: {
					type: "string",
					enum: ["main", "isolated"],
					description:
						'Execution mode: "main" queues as heartbeat wake item, "isolated" runs as separate job (default: "isolated")',
				},
				model: {
					type: "string",
					description: "Override the default model for this job",
				},
			},
			required: ["action"],
		},
	},
	{
		name: "wake_heartbeat",
		description:
			"Queue a wake item for the next heartbeat tick. Use this to schedule quick reminders or follow-ups that should be handled during the next heartbeat check-in.",
		inputSchema: {
			type: "object" as const,
			properties: {
				text: {
					type: "string",
					description: "The reminder or follow-up text to include in the next heartbeat",
				},
			},
			required: ["text"],
		},
	},
];

// ---------------------------------------------------------------------------
// Gateway HTTP client
// ---------------------------------------------------------------------------

async function gatewayFetch(
	path: string,
	options: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const url = `${GATEWAY_URL}${path}`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (GATEWAY_TOKEN) {
		headers.Authorization = `Bearer ${GATEWAY_TOKEN}`;
	}

	try {
		const resp = await fetch(url, {
			method: options.method ?? "GET",
			headers,
			body: options.body ? JSON.stringify(options.body) : undefined,
			signal: AbortSignal.timeout(10_000),
		});
		const data = await resp.json();
		return { ok: resp.ok, status: resp.status, data };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(`Scheduler not available — gateway is not running (${message})`);
	}
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleScheduleInfo(): Promise<unknown> {
	const { data } = await gatewayFetch("/scheduler");
	return data;
}

async function handleScheduleCron(params: Record<string, unknown>): Promise<unknown> {
	const action = params.action as string;

	if (!action || !["list", "add", "remove"].includes(action)) {
		throw new ToolError(`Invalid or missing action. Use "list", "add", or "remove".`);
	}

	if (action === "list") {
		const { data } = await gatewayFetch("/cron");
		return data;
	}

	if (action === "add") {
		const name = params.name as string | undefined;
		const prompt = params.prompt as string | undefined;
		if (!name || !prompt) {
			throw new ToolError("name and prompt are required for action 'add'");
		}
		const body: Record<string, unknown> = {
			name,
			prompt,
			schedule: params.schedule ?? { every: "1h" },
			execution: params.execution ?? "isolated",
		};
		if (params.model) body.model = params.model;

		const { ok, data } = await gatewayFetch("/cron", { method: "POST", body });
		if (!ok) {
			const errMsg = (data as { error?: string })?.error ?? "Failed to add cron job";
			throw new ToolError(errMsg);
		}
		return data;
	}

	// action === "remove"
	const name = params.name as string | undefined;
	if (!name) {
		throw new ToolError("name is required for action 'remove'");
	}
	const { ok, data } = await gatewayFetch(`/cron/${encodeURIComponent(name)}`, {
		method: "DELETE",
	});
	if (!ok) {
		const errMsg = (data as { error?: string })?.error ?? "Cron job not found";
		throw new ToolError(errMsg);
	}
	return data;
}

async function handleWakeHeartbeat(params: Record<string, unknown>): Promise<unknown> {
	const text = params.text as string | undefined;
	if (!text) {
		throw new ToolError("text is required");
	}

	const { ok, data } = await gatewayFetch("/heartbeat/wake", {
		method: "POST",
		body: { text },
	});
	if (!ok) {
		const errMsg = (data as { error?: string })?.error ?? "Failed to queue wake item";
		throw new ToolError(errMsg);
	}
	return { ok: true, message: `Wake item queued: "${text.slice(0, 100)}"` };
}

// ---------------------------------------------------------------------------
// Handler map + start server
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<string, ToolHandler> = {
	schedule_info: handleScheduleInfo,
	schedule_cron: handleScheduleCron,
	wake_heartbeat: handleWakeHeartbeat,
};

startMcpServer({
	serverName: `randal-scheduler (gateway: ${GATEWAY_URL})`,
	serverVersion: "1.0.0",
	tools: TOOL_DEFINITIONS,
	handlers: TOOL_HANDLERS,
});
