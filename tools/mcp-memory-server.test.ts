import { afterAll, beforeAll, describe, expect, test } from "bun:test";
/**
 * Unit tests for posse delegation tool handlers in mcp-memory-server.
 *
 * These tests exercise the JSON-RPC dispatch by spawning the MCP server
 * as a subprocess and sending tool calls via stdin. This tests the full
 * handler path including env var configuration and graceful degradation.
 */
import { type Subprocess, spawn } from "bun";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: {
		content?: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	error?: { code: number; message: string };
}

/**
 * Send a JSON-RPC request to the MCP server subprocess and read the response.
 */
async function callTool(
	proc: Subprocess,
	toolName: string,
	args: Record<string, unknown>,
	id = 1,
): Promise<JsonRpcResponse> {
	const request = JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name: toolName, arguments: args },
	});

	const stdin = proc.stdin as import("bun").FileSink;
	stdin.write(`${request}\n`);
	stdin.flush();

	// Read response line from stdout
	const stdout = proc.stdout as ReadableStream<Uint8Array>;
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const newlineIdx = buffer.indexOf("\n");
		if (newlineIdx !== -1) {
			const line = buffer.slice(0, newlineIdx).trim();
			reader.releaseLock();
			if (line) return JSON.parse(line) as JsonRpcResponse;
		}
	}

	reader.releaseLock();
	throw new Error("No response received from MCP server");
}

/** Parse the text content from a tool response. */
function parseToolResult(resp: JsonRpcResponse): unknown {
	const text = resp.result?.content?.[0]?.text;
	if (!text) throw new Error("No text content in response");
	return JSON.parse(text);
}

/**
 * Start the MCP server with custom env and send the initialize handshake.
 */
async function startServer(envOverrides: Record<string, string> = {}): Promise<Subprocess> {
	const proc = spawn(["bun", "run", "tools/mcp-memory-server.ts"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			// Disable Meilisearch auto-start and set a bogus URL so init fails fast
			RANDAL_SKIP_MEILISEARCH: "true",
			MEILI_URL: "http://localhost:19876",
			...envOverrides,
		},
		cwd: import.meta.dir.replace(/\/tools$/, ""),
	});

	// Send initialize handshake
	const initReq = JSON.stringify({
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: {},
	});
	const stdin = proc.stdin as import("bun").FileSink;
	stdin.write(`${initReq}\n`);
	stdin.flush();

	// Read initialize response
	const stdout = proc.stdout as ReadableStream<Uint8Array>;
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const newlineIdx = buffer.indexOf("\n");
		if (newlineIdx !== -1) {
			reader.releaseLock();
			break;
		}
	}

	// Give the server a moment to finish background init
	await Bun.sleep(500);

	return proc;
}

// ---------------------------------------------------------------------------
// Tests: posse_members — not configured
// ---------------------------------------------------------------------------

describe("posse_members", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			RANDAL_POSSE_NAME: "",
			RANDAL_SELF_NAME: "",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("returns 'posse not configured' when env vars are unset", async () => {
		const resp = await callTool(proc, "posse_members", {});
		const result = parseToolResult(resp) as { members: unknown[]; message: string };
		expect(result.members).toEqual([]);
		expect(result.message).toContain("Posse not configured");
	});
});

// ---------------------------------------------------------------------------
// Tests: delegate_task — not configured and self-delegation
// ---------------------------------------------------------------------------

describe("delegate_task", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			RANDAL_POSSE_NAME: "",
			RANDAL_SELF_NAME: "",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("returns 'posse not configured' when env vars are unset", async () => {
		const resp = await callTool(proc, "delegate_task", { task: "test task" });
		const result = parseToolResult(resp) as { delegated: boolean; message: string };
		expect(result.delegated).toBe(false);
		expect(result.message).toContain("Posse not configured");
	});

	test("returns error when task parameter is missing", async () => {
		const resp = await callTool(proc, "delegate_task", {}, 2);
		expect(resp.result?.isError).toBe(true);
		expect(resp.result?.content?.[0]?.text).toContain("Missing required parameter: task");
	});
});

describe("delegate_task — self-delegation guard", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			RANDAL_POSSE_NAME: "test-posse",
			RANDAL_SELF_NAME: "self-agent",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("rejects delegation to self", async () => {
		const resp = await callTool(proc, "delegate_task", {
			task: "some task",
			target: "self-agent",
		});
		const result = parseToolResult(resp) as { delegated: boolean; message: string };
		expect(result.delegated).toBe(false);
		expect(result.message).toContain("Cannot delegate to self");
	});
});

// ---------------------------------------------------------------------------
// Tests: posse_memory_search — not configured
// ---------------------------------------------------------------------------

describe("posse_memory_search", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			RANDAL_POSSE_NAME: "",
			RANDAL_SELF_NAME: "",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("returns 'posse not configured' when env vars are unset", async () => {
		const resp = await callTool(proc, "posse_memory_search", { query: "test" });
		const result = parseToolResult(resp) as { results: unknown[]; message: string };
		expect(result.results).toEqual([]);
		expect(result.message).toContain("Posse not configured");
	});

	test("returns error when query parameter is missing", async () => {
		const resp = await callTool(proc, "posse_memory_search", {}, 2);
		expect(resp.result?.isError).toBe(true);
		expect(resp.result?.content?.[0]?.text).toContain("Missing required parameter: query");
	});
});

describe("posse_memory_search — no indexes configured", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			RANDAL_POSSE_NAME: "test-posse",
			RANDAL_SELF_NAME: "self-agent",
			RANDAL_CROSS_AGENT_READ_FROM: "",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("returns helpful message when no indexes are configured", async () => {
		const resp = await callTool(proc, "posse_memory_search", { query: "test" });
		const result = parseToolResult(resp) as { results: unknown[]; message: string };
		expect(result.results).toEqual([]);
		expect(result.message).toContain("No cross-agent indexes configured");
	});
});

// ---------------------------------------------------------------------------
// Tests: job_info — channel awareness (interactive mode)
// ---------------------------------------------------------------------------

describe("job_info — interactive mode", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			// Ensure channel env vars are unset (interactive mode)
			RANDAL_JOB_ID: "",
			RANDAL_CHANNEL: "",
			RANDAL_FROM: "",
			RANDAL_REPLY_TO: "",
			RANDAL_TRIGGER: "",
			RANDAL_BRAIN_SESSION: "",
			RANDAL_GATEWAY_URL: "",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("returns defaults in interactive mode (no env vars)", async () => {
		const resp = await callTool(proc, "job_info", {});
		const result = parseToolResult(resp) as {
			jobId: string | null;
			channel: string | null;
			from: string | null;
			replyTo: string | null;
			triggerType: string;
			isBrainSession: boolean;
			isInteractive: boolean;
			gatewayAvailable: boolean;
		};
		expect(result.isInteractive).toBe(true);
		expect(result.channel).toBeNull();
		expect(result.jobId).toBeNull();
		expect(result.from).toBeNull();
		expect(result.replyTo).toBeNull();
		expect(result.triggerType).toBe("user");
		expect(result.isBrainSession).toBe(false);
		expect(result.gatewayAvailable).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: job_info — channel awareness (channel mode)
// ---------------------------------------------------------------------------

describe("job_info — channel mode", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			RANDAL_JOB_ID: "abc123",
			RANDAL_CHANNEL: "discord",
			RANDAL_FROM: "user-456",
			RANDAL_REPLY_TO: "thread-789",
			RANDAL_TRIGGER: "cron",
			RANDAL_BRAIN_SESSION: "true",
			RANDAL_GATEWAY_URL: "http://localhost:7600",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("returns origin metadata when env vars are set", async () => {
		const resp = await callTool(proc, "job_info", {});
		const result = parseToolResult(resp) as {
			jobId: string | null;
			channel: string | null;
			from: string | null;
			replyTo: string | null;
			triggerType: string;
			isBrainSession: boolean;
			isInteractive: boolean;
			gatewayAvailable: boolean;
		};
		expect(result.isInteractive).toBe(false);
		expect(result.jobId).toBe("abc123");
		expect(result.channel).toBe("discord");
		expect(result.from).toBe("user-456");
		expect(result.replyTo).toBe("thread-789");
		expect(result.triggerType).toBe("cron");
		expect(result.isBrainSession).toBe(true);
		expect(result.gatewayAvailable).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: channel_list — interactive mode
// ---------------------------------------------------------------------------

describe("channel_list — interactive mode", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			RANDAL_GATEWAY_URL: "",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("returns empty with message in interactive mode", async () => {
		const resp = await callTool(proc, "channel_list", {});
		const result = parseToolResult(resp) as { channels: unknown[]; message: string };
		expect(result.channels).toEqual([]);
		expect(result.message).toContain("interactive mode");
	});
});

// ---------------------------------------------------------------------------
// Tests: channel_send — interactive mode and validation
// ---------------------------------------------------------------------------

describe("channel_send — interactive mode", () => {
	let proc: Subprocess;

	beforeAll(async () => {
		proc = await startServer({
			RANDAL_GATEWAY_URL: "",
		});
	});

	afterAll(() => {
		proc.kill();
	});

	test("returns not-sent in interactive mode", async () => {
		const resp = await callTool(proc, "channel_send", {
			channel: "discord",
			target: "123",
			message: "hello",
		});
		const result = parseToolResult(resp) as { sent: boolean; message: string };
		expect(result.sent).toBe(false);
		expect(result.message).toContain("interactive mode");
	});

	test("validates required parameters", async () => {
		const resp = await callTool(proc, "channel_send", { channel: "discord" }, 2);
		expect(resp.result?.isError).toBe(true);
		expect(resp.result?.content?.[0]?.text).toContain("Missing required parameter: target");
	});
});
