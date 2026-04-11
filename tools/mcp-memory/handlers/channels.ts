/**
 * Channel awareness + utility tool handlers.
 *
 * Includes: job_info, channel_list, channel_send, emit_event,
 * struggle_check, and context_check.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { checkStruggle } from "@randal/runner";
import { ToolError } from "../../lib/mcp-transport.js";
import type { ToolDefinition, ToolHandler } from "../../lib/mcp-transport.js";
import {
	RANDAL_BRAIN_SESSION,
	RANDAL_CHANNEL,
	RANDAL_FROM,
	RANDAL_GATEWAY_AUTH,
	RANDAL_GATEWAY_URL,
	RANDAL_JOB_ID,
	RANDAL_REPLY_TO,
	RANDAL_TRIGGER,
} from "../types.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
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
	{
		name: "emit_event",
		description:
			"Emit a structured event to all connected channels (Discord, iMessage, etc.). Use this to send intentional notifications or alerts — not for routine progress (use <progress> tags for that). Types: 'notification' for milestones ('Auth refactor complete'), 'alert' for issues needing human attention ('Build stuck, need help'), 'progress' for status updates. Rate limited to 1 per type per 10 seconds.",
		inputSchema: {
			type: "object" as const,
			properties: {
				type: {
					type: "string",
					enum: ["notification", "alert", "progress"],
					description:
						"Event type: notification (milestone), alert (needs human attention), progress (status update)",
				},
				message: {
					type: "string",
					description: "The event message (max 2000 chars). Be concise and actionable.",
				},
				severity: {
					type: "string",
					enum: ["info", "warning", "critical"],
					description: "Severity level (default: info for notifications, warning for alerts)",
				},
				channel: {
					type: "string",
					description:
						"Target a specific channel (discord, imessage). Omit to send to the originating channel.",
				},
			},
			required: ["type", "message"],
		},
	},
];

// ---------------------------------------------------------------------------
// Gateway helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Handlers
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

async function handleEmitEvent(params: Record<string, unknown>): Promise<unknown> {
	const type = params.type as string;
	const message = params.message as string;
	const severity = params.severity as string | undefined;
	const channel = params.channel as string | undefined;

	if (!type || !message) {
		throw new ToolError("Missing required parameters: type and message");
	}

	if (!RANDAL_JOB_ID) {
		// Interactive mode — log the event but don't try to route it
		return {
			emitted: false,
			message: "Event logged (interactive mode — no gateway connection)",
			type,
			eventMessage: message,
		};
	}

	if (!RANDAL_GATEWAY_URL) {
		return {
			emitted: false,
			message: "No gateway URL configured — event not routed",
			type,
			eventMessage: message,
		};
	}

	try {
		const resp = await fetch(`${RANDAL_GATEWAY_URL}/_internal/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type,
				jobId: RANDAL_JOB_ID,
				message,
				severity,
				targetChannel: channel,
			}),
		});

		if (resp.status === 429) {
			const body = (await resp.json()) as { retryAfterSeconds?: number };
			return {
				emitted: false,
				rateLimited: true,
				retryAfterSeconds: body.retryAfterSeconds ?? 10,
				message: "Rate limited — wait before sending another event of this type",
			};
		}

		if (!resp.ok) {
			const body = (await resp.json().catch(() => ({}))) as { error?: string };
			return {
				emitted: false,
				message: `Gateway error: ${body.error ?? resp.statusText}`,
			};
		}

		return { emitted: true, type: `brain.${type}`, jobId: RANDAL_JOB_ID };
	} catch (err) {
		return {
			emitted: false,
			message: `Failed to reach gateway: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, ToolHandler> = {
	struggle_check: handleStruggleCheck,
	context_check: handleContextCheck,
	job_info: handleJobInfo,
	channel_list: handleChannelList,
	channel_send: handleChannelSend,
	emit_event: handleEmitEvent,
};

/**
 * Register channel awareness and utility tool definitions and handlers.
 * Returns { definitions, handlers } for the entrypoint to merge.
 */
export function registerChannelHandlers() {
	return { definitions: TOOL_DEFINITIONS, handlers: HANDLERS };
}
