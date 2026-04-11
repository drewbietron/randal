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

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const GATEWAY_URL = process.env.RANDAL_GATEWAY_URL || "http://localhost:7600";
const GATEWAY_TOKEN = process.env.RANDAL_GATEWAY_TOKEN || "";

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

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Input validation (Zod)
// ---------------------------------------------------------------------------

import { z } from "zod";

class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

function validateParams<T>(params: Record<string, unknown>, schema: z.ZodType<T>): T {
	const result = schema.safeParse(params);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		throw new ToolError(`Invalid parameters: ${issues}`);
	}
	return result.data;
}

const ScheduleCronParamsSchema = z
	.object({
		action: z.enum(["list", "add", "remove"]),
		name: z.string().optional(),
		schedule: z
			.union([z.string(), z.object({ every: z.string() }), z.object({ at: z.string() })])
			.optional(),
		prompt: z.string().optional(),
		execution: z.enum(["main", "isolated"]).optional(),
		model: z.string().optional(),
	})
	.refine(
		(data) => {
			if (data.action === "add") return !!data.name && !!data.prompt;
			if (data.action === "remove") return !!data.name;
			return true;
		},
		{
			message: "name and prompt are required for action 'add'; name is required for action 'remove'",
		},
	);

const WakeHeartbeatParamsSchema = z.object({
	text: z.string().min(1, "text is required and must be non-empty"),
});

// ---------------------------------------------------------------------------
// MCP tool schema definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
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
		throw new Error(`Scheduler not available — gateway is not running (${message})`);
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
	const validated = validateParams(params, ScheduleCronParamsSchema);
	const { action } = validated;

	if (action === "list") {
		const { data } = await gatewayFetch("/cron");
		return data;
	}

	if (action === "add") {
		const { name, prompt } = validated;
		const body: Record<string, unknown> = {
			name,
			prompt,
			schedule: validated.schedule ?? { every: "1h" },
			execution: validated.execution ?? "isolated",
		};
		if (validated.model) body.model = validated.model;

		const { ok, data } = await gatewayFetch("/cron", { method: "POST", body });
		if (!ok) {
			const errMsg = (data as { error?: string })?.error ?? "Failed to add cron job";
			throw new ToolError(errMsg);
		}
		return data;
	}

	if (action === "remove") {
		const { name } = validated;
		const { ok, data } = await gatewayFetch(`/cron/${encodeURIComponent(name!)}`, {
			method: "DELETE",
		});
		if (!ok) {
			const errMsg = (data as { error?: string })?.error ?? "Cron job not found";
			throw new ToolError(errMsg);
		}
		return data;
	}

	// Unreachable due to z.enum, but keep for defensive safety
	throw new ToolError(`Unknown action: ${action}. Use "list", "add", or "remove".`);
}

async function handleWakeHeartbeat(params: Record<string, unknown>): Promise<unknown> {
	const { text } = validateParams(params, WakeHeartbeatParamsSchema);

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
// Tool dispatch
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
	schedule_info: handleScheduleInfo,
	schedule_cron: handleScheduleCron,
	wake_heartbeat: handleWakeHeartbeat,
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
	const { id, method, params } = req;

	// --- initialize ---
	if (method === "initialize") {
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: {
					name: "randal-scheduler",
					version: "1.0.0",
				},
			},
		};
	}

	// --- notifications/initialized ---
	if (method === "notifications/initialized") {
		return null; // No response for notifications
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
		const toolName = (params?.name ?? "") as string;
		const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

		const handler = TOOL_HANDLERS[toolName];
		if (!handler) {
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: RPC_METHOD_NOT_FOUND,
					message: `Unknown tool: ${toolName}`,
				},
			};
		}

		try {
			const result = await handler(toolArgs);
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
			const isToolError = err instanceof ToolError;

			if (isToolError) {
				return {
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: JSON.stringify({ error: message }) }],
						isError: true,
					},
				};
			}

			log("warn", `Tool invocation failed: ${toolName} — ${message}`);
			return {
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: JSON.stringify({ error: message }) }],
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

function send(response: JsonRpcResponse): void {
	const line = `${JSON.stringify(response)}\n`;
	process.stdout.write(line);
}

function log(level: "info" | "warn" | "error", message: string): void {
	const ts = new Date().toISOString();
	process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${message}\n`);
}

async function processLine(line: string): Promise<void> {
	const trimmed = line.trim();
	if (!trimmed) return;

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

	if (!req.jsonrpc || req.jsonrpc !== "2.0" || !req.method) {
		send({
			jsonrpc: "2.0",
			id: req.id ?? null,
			error: { code: RPC_INVALID_REQUEST, message: "Invalid JSON-RPC request" },
		});
		return;
	}

	const isNotification = req.id === undefined || req.id === null;

	try {
		const response = await dispatch(req as JsonRpcRequest);

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
	log("info", `randal-scheduler MCP server starting (gateway: ${GATEWAY_URL})`);
	log("info", "Listening on stdin for JSON-RPC requests...");

	const decoder = new TextDecoder();
	let buffer = "";

	const stdin = Bun.stdin.stream();
	const reader = stdin.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			let newlineIdx: number = buffer.indexOf("\n");
			while (newlineIdx !== -1) {
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				await processLine(line);
				newlineIdx = buffer.indexOf("\n");
			}
		}

		if (buffer.trim()) {
			await processLine(buffer);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log("info", `stdin closed: ${message}`);
	}

	log("info", "MCP server shutting down");
}

main().catch((err) => {
	log("error", `Fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
