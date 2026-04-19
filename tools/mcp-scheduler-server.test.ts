import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock gateway server — simulates the gateway HTTP API
// ---------------------------------------------------------------------------

let mockServer: ReturnType<typeof Bun.serve>;
let gatewayUrl: string;

const mockSchedulerStatus = {
	heartbeat: {
		lastTick: "2026-04-07T06:00:00Z",
		nextTick: "2026-04-07T06:30:00Z",
		tickCount: 42,
		pendingWakeItems: [
			{ text: "Check PR review", source: "hook", timestamp: "2026-04-07T05:55:00Z" },
		],
	},
	cron: [
		{
			name: "daily-review",
			config: {
				name: "daily-review",
				schedule: "0 9 * * 1-5",
				prompt: "Review PRs",
				execution: "isolated",
				announce: false,
			},
			lastRun: "2026-04-07T09:00:00Z",
			nextRun: "cron-expression",
			runCount: 5,
			status: "active",
		},
	],
	hooks: { enabled: true, pendingItems: 1 },
};

const mockCronJobs = mockSchedulerStatus.cron;

beforeAll(() => {
	mockServer = Bun.serve({
		port: 0, // Random available port
		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			if (path === "/scheduler" && req.method === "GET") {
				return Response.json(mockSchedulerStatus);
			}

			if (path === "/cron" && req.method === "GET") {
				return Response.json(mockCronJobs);
			}

			if (path === "/cron" && req.method === "POST") {
				const body = await req.json();
				if (!body.name || !body.prompt) {
					return Response.json({ error: "name and prompt are required" }, { status: 400 });
				}
				return Response.json({ ok: true, name: body.name }, { status: 201 });
			}

			if (path.startsWith("/cron/") && req.method === "DELETE") {
				const name = decodeURIComponent(path.replace("/cron/", ""));
				if (name === "nonexistent") {
					return Response.json({ error: "Cron job not found" }, { status: 404 });
				}
				return Response.json({ ok: true, name });
			}

			if (path === "/heartbeat/wake" && req.method === "POST") {
				const body = await req.json();
				if (!body.text) {
					return Response.json({ error: "text required" }, { status: 400 });
				}
				return Response.json({ ok: true });
			}

			return Response.json({ error: "Not found" }, { status: 404 });
		},
	});
	gatewayUrl = `http://localhost:${mockServer.port}`;
});

afterAll(() => {
	mockServer.stop();
});

// ---------------------------------------------------------------------------
// Helper: send a JSON-RPC request to the MCP server via subprocess
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
}

async function callMcpServer(
	method: string,
	params?: Record<string, unknown>,
	overrideUrl?: string,
	envOverrides: Record<string, string> = {},
): Promise<JsonRpcResponse> {
	const request = {
		jsonrpc: "2.0",
		id: 1,
		method,
		params,
	};

	// Send initialize first, then the actual request
	const initReq = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
	const actualReq = JSON.stringify(request);
	const input = `${initReq}\n${actualReq}\n`;

	const proc = Bun.spawn(
		["bun", "run", new URL("./mcp-scheduler-server.ts", import.meta.url).pathname],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				RANDAL_GATEWAY_URL: overrideUrl ?? gatewayUrl,
				RANDAL_GATEWAY_TOKEN: "",
				...envOverrides,
			},
		},
	);

	// Write input and close stdin
	proc.stdin.write(input);
	proc.stdin.end();

	// Read all stdout
	const output = await new Response(proc.stdout).text();
	await proc.exited;

	// Parse the responses — we want the second one (the actual response, not initialize)
	const lines = output.trim().split("\n").filter(Boolean);
	if (lines.length < 2) {
		throw new Error(`Expected at least 2 JSON-RPC responses, got ${lines.length}: ${output}`);
	}

	return JSON.parse(lines[1]) as JsonRpcResponse;
}

function parseToolResult(response: JsonRpcResponse): { text: string; isError?: boolean } {
	const result = response.result as {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	return {
		text: result.content[0].text,
		isError: result.isError,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Scheduler Server", () => {
	describe("schedule_info", () => {
		test("returns scheduler status from gateway", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_info",
				arguments: {},
			});

			expect(response.error).toBeUndefined();
			const { text } = parseToolResult(response);
			const data = JSON.parse(text);
			expect(data.heartbeat.tickCount).toBe(42);
			expect(data.cron).toHaveLength(1);
			expect(data.cron[0].name).toBe("daily-review");
			expect(data.hooks.enabled).toBe(true);
		});

		test("returns error when gateway is unreachable", async () => {
			const response = await callMcpServer(
				"tools/call",
				{ name: "schedule_info", arguments: {} },
				"http://127.0.0.1:1", // Unreachable port
			);

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("gateway is not running");
		});

		test("denies external voice sessions without scheduler grant", async () => {
			const response = await callMcpServer(
				"tools/call",
				{ name: "schedule_info", arguments: {} },
				undefined,
				{
					RANDAL_SESSION_ACCESS_CLASS: "external",
					RANDAL_SESSION_ALLOWED_GRANTS: "memory",
				},
			);

			const { text } = parseToolResult(response);
			expect(JSON.parse(text)).toEqual({
				message: "Voice session is not allowed to use scheduler tools",
			});
		});
	});

	describe("schedule_cron", () => {
		test("list returns cron jobs", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "list" },
			});

			expect(response.error).toBeUndefined();
			const { text } = parseToolResult(response);
			const data = JSON.parse(text);
			expect(data).toHaveLength(1);
			expect(data[0].name).toBe("daily-review");
		});

		test("add creates a cron job", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: {
					action: "add",
					name: "check-deploy",
					prompt: "Check if deploy succeeded",
					schedule: { at: "2026-04-08T10:00:00Z" },
					execution: "isolated",
				},
			});

			expect(response.error).toBeUndefined();
			const { text } = parseToolResult(response);
			const data = JSON.parse(text);
			expect(data.ok).toBe(true);
			expect(data.name).toBe("check-deploy");
		});

		test("add rejects missing name", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "add", prompt: "Do something" },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("name and prompt are required");
		});

		test("add rejects missing prompt", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "add", name: "test-job" },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("name and prompt are required");
		});

		test("remove deletes a cron job", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "remove", name: "daily-review" },
			});

			expect(response.error).toBeUndefined();
			const { text } = parseToolResult(response);
			const data = JSON.parse(text);
			expect(data.ok).toBe(true);
			expect(data.name).toBe("daily-review");
		});

		test("remove returns error for nonexistent job", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "remove", name: "nonexistent" },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("Cron job not found");
		});

		test("remove rejects missing name", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "remove" },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("name is required");
		});

		test("rejects unknown action", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "pause" },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("Unknown action");
		});
	});

	describe("wake_heartbeat", () => {
		test("queues a wake item", async () => {
			const response = await callMcpServer("tools/call", {
				name: "wake_heartbeat",
				arguments: { text: "Follow up on auth refactor" },
			});

			expect(response.error).toBeUndefined();
			const { text } = parseToolResult(response);
			const data = JSON.parse(text);
			expect(data.ok).toBe(true);
			expect(data.message).toContain("Follow up on auth refactor");
		});

		test("rejects missing text", async () => {
			const response = await callMcpServer("tools/call", {
				name: "wake_heartbeat",
				arguments: {},
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("text is required");
		});

		test("returns error when gateway is unreachable", async () => {
			const response = await callMcpServer(
				"tools/call",
				{ name: "wake_heartbeat", arguments: { text: "test" } },
				"http://127.0.0.1:1",
			);

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("gateway is not running");
		});
	});

	describe("tools/list", () => {
		test("returns all three tools", async () => {
			const response = await callMcpServer("tools/list");

			expect(response.error).toBeUndefined();
			const result = response.result as { tools: Array<{ name: string }> };
			const names = result.tools.map((t) => t.name).sort();
			expect(names).toEqual(["schedule_cron", "schedule_info", "wake_heartbeat"]);
		});
	});

	describe("unknown tool", () => {
		test("returns error for unknown tool name", async () => {
			const response = await callMcpServer("tools/call", {
				name: "nonexistent_tool",
				arguments: {},
			});

			expect(response.error).toBeDefined();
			expect(response.error?.message).toContain("Unknown tool");
		});
	});

	// ── Input validation security tests ──────────────────────

	describe("schedule_cron — param validation", () => {
		test("action 'add' missing both name and prompt returns validation error", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "add" },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("name and prompt are required");
		});

		test("action 'invalid' returns validation error", async () => {
			const response = await callMcpServer("tools/call", {
				name: "schedule_cron",
				arguments: { action: "invalid" },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("Unknown action");
		});
	});

	describe("wake_heartbeat — param validation", () => {
		test("empty string text returns validation error", async () => {
			const response = await callMcpServer("tools/call", {
				name: "wake_heartbeat",
				arguments: { text: "" },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			expect(text).toContain("text is required");
		});

		test("wrong type (text: 123) returns internal error (no type validation in handler)", async () => {
			const response = await callMcpServer("tools/call", {
				name: "wake_heartbeat",
				arguments: { text: 123 },
			});

			expect(response.error).toBeUndefined();
			const { text, isError } = parseToolResult(response);
			expect(isError).toBe(true);
			// The handler casts to string but 123 is truthy so it passes the !text check,
			// then text.slice() fails because 123 is a number — caught as an internal error.
			expect(text).toContain("Internal error");
		});
	});
});
