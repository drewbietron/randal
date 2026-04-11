/**
 * Unit tests for the shared MCP JSON-RPC transport layer.
 *
 * Tests createDispatcher() and processLine() in isolation — no subprocess needed.
 */

import { describe, expect, test } from "bun:test";
import {
	type JsonRpcRequest,
	type JsonRpcResponse,
	RPC_INTERNAL_ERROR,
	RPC_INVALID_PARAMS,
	RPC_INVALID_REQUEST,
	RPC_METHOD_NOT_FOUND,
	RPC_PARSE_ERROR,
	ToolError,
	createDispatcher,
	processLine,
} from "../mcp-transport.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SAMPLE_TOOL = {
	name: "echo",
	description: "Echoes input",
	inputSchema: {
		type: "object" as const,
		properties: { text: { type: "string" } },
		required: ["text"],
	},
};

function makeDispatcher(
	handlerOverrides: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {},
) {
	return createDispatcher({
		serverName: "test-server",
		serverVersion: "1.0.0",
		tools: [SAMPLE_TOOL],
		handlers: {
			echo: async (params) => ({ echoed: params.text }),
			...handlerOverrides,
		},
	});
}

function makeRequest(
	method: string,
	params?: Record<string, unknown>,
	id: string | number = 1,
): JsonRpcRequest {
	return { jsonrpc: "2.0", id, method, params };
}

/**
 * Capture responses sent via processLine by temporarily intercepting process.stdout.write.
 */
async function captureProcessLine(
	line: string,
	dispatch: (req: JsonRpcRequest) => Promise<JsonRpcResponse | null>,
): Promise<JsonRpcResponse | null> {
	let captured: JsonRpcResponse | null = null;
	const originalWrite = process.stdout.write;
	// @ts-expect-error — overriding for test capture
	process.stdout.write = (data: string) => {
		const trimmed = data.trim();
		if (trimmed) captured = JSON.parse(trimmed);
		return true;
	};
	try {
		await processLine(line, dispatch);
	} finally {
		process.stdout.write = originalWrite;
	}
	return captured;
}

// ---------------------------------------------------------------------------
// createDispatcher tests
// ---------------------------------------------------------------------------

describe("createDispatcher", () => {
	describe("initialize", () => {
		test("returns protocol version, server info, and capabilities", async () => {
			const dispatch = makeDispatcher();
			const resp = await dispatch(makeRequest("initialize"));

			expect(resp).not.toBeNull();
			const result = resp?.result as {
				protocolVersion: string;
				serverInfo: { name: string; version: string };
				capabilities: { tools: { listChanged: boolean } };
			};
			expect(result.protocolVersion).toBe("2024-11-05");
			expect(result.serverInfo.name).toBe("test-server");
			expect(result.serverInfo.version).toBe("1.0.0");
			expect(result.capabilities.tools.listChanged).toBe(false);
		});
	});

	describe("notifications/initialized", () => {
		test("returns null (no response for notifications)", async () => {
			const dispatch = makeDispatcher();
			const resp = await dispatch(makeRequest("notifications/initialized"));
			expect(resp).toBeNull();
		});
	});

	describe("ping", () => {
		test("returns empty result object", async () => {
			const dispatch = makeDispatcher();
			const resp = await dispatch(makeRequest("ping"));

			expect(resp).not.toBeNull();
			expect(resp?.result).toEqual({});
		});
	});

	describe("tools/list", () => {
		test("returns the tool definitions array", async () => {
			const dispatch = makeDispatcher();
			const resp = await dispatch(makeRequest("tools/list"));

			expect(resp).not.toBeNull();
			const result = resp?.result as { tools: Array<{ name: string }> };
			expect(result.tools).toHaveLength(1);
			expect(result.tools[0].name).toBe("echo");
		});
	});

	describe("tools/call", () => {
		test("routes to handler and returns content", async () => {
			const dispatch = makeDispatcher();
			const resp = await dispatch(
				makeRequest("tools/call", { name: "echo", arguments: { text: "hello" } }),
			);

			expect(resp).not.toBeNull();
			expect(resp?.error).toBeUndefined();
			const result = resp?.result as { content: Array<{ type: string; text: string }> };
			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.echoed).toBe("hello");
		});

		test("returns RPC_INVALID_PARAMS when name is missing", async () => {
			const dispatch = makeDispatcher();
			const resp = await dispatch(makeRequest("tools/call", {}));

			expect(resp).not.toBeNull();
			expect(resp?.error).toBeDefined();
			expect(resp?.error?.code).toBe(RPC_INVALID_PARAMS);
			expect(resp?.error?.message).toContain("Missing tool name");
		});

		test("returns RPC_METHOD_NOT_FOUND for unknown tool", async () => {
			const dispatch = makeDispatcher();
			const resp = await dispatch(
				makeRequest("tools/call", { name: "nonexistent", arguments: {} }),
			);

			expect(resp).not.toBeNull();
			expect(resp?.error).toBeDefined();
			expect(resp?.error?.code).toBe(RPC_METHOD_NOT_FOUND);
			expect(resp?.error?.message).toContain("Unknown tool: nonexistent");
		});

		test("wraps ToolError in isError content response", async () => {
			const dispatch = makeDispatcher({
				echo: async () => {
					throw new ToolError("Bad input");
				},
			});
			const resp = await dispatch(makeRequest("tools/call", { name: "echo", arguments: {} }));

			expect(resp).not.toBeNull();
			expect(resp?.error).toBeUndefined();
			const result = resp?.result as { content: Array<{ text: string }>; isError: boolean };
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toBe("Error: Bad input");
		});

		test("wraps non-ToolError in isError with 'Internal error' prefix", async () => {
			const dispatch = makeDispatcher({
				echo: async () => {
					throw new Error("kaboom");
				},
			});
			const resp = await dispatch(makeRequest("tools/call", { name: "echo", arguments: {} }));

			expect(resp).not.toBeNull();
			expect(resp?.error).toBeUndefined();
			const result = resp?.result as { content: Array<{ text: string }>; isError: boolean };
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toBe("Internal error: kaboom");
		});

		test("returns string results directly", async () => {
			const dispatch = makeDispatcher({
				echo: async () => "plain string result",
			});
			const resp = await dispatch(makeRequest("tools/call", { name: "echo", arguments: {} }));

			const result = resp?.result as { content: Array<{ text: string }> };
			expect(result.content[0].text).toBe("plain string result");
		});
	});

	describe("unknown method", () => {
		test("returns RPC_METHOD_NOT_FOUND", async () => {
			const dispatch = makeDispatcher();
			const resp = await dispatch(makeRequest("foo/bar"));

			expect(resp).not.toBeNull();
			expect(resp?.error).toBeDefined();
			expect(resp?.error?.code).toBe(RPC_METHOD_NOT_FOUND);
			expect(resp?.error?.message).toContain("Unknown method: foo/bar");
		});
	});
});

// ---------------------------------------------------------------------------
// processLine tests
// ---------------------------------------------------------------------------

describe("processLine", () => {
	const dispatch = makeDispatcher();

	test("routes a valid JSON-RPC request and sends response", async () => {
		const req = JSON.stringify({
			jsonrpc: "2.0",
			id: 42,
			method: "tools/call",
			params: { name: "echo", arguments: { text: "test" } },
		});

		const resp = await captureProcessLine(req, dispatch);
		expect(resp).not.toBeNull();
		expect(resp?.id).toBe(42);
		expect(resp?.error).toBeUndefined();
	});

	test("returns RPC_PARSE_ERROR for invalid JSON", async () => {
		const resp = await captureProcessLine("{not valid json}", dispatch);

		expect(resp).not.toBeNull();
		expect(resp?.id).toBeNull();
		expect(resp?.error).toBeDefined();
		expect(resp?.error?.code).toBe(RPC_PARSE_ERROR);
		expect(resp?.error?.message).toBe("Invalid JSON");
	});

	test("returns RPC_INVALID_REQUEST for missing jsonrpc field", async () => {
		const resp = await captureProcessLine(JSON.stringify({ id: 1, method: "ping" }), dispatch);

		expect(resp).not.toBeNull();
		expect(resp?.error).toBeDefined();
		expect(resp?.error?.code).toBe(RPC_INVALID_REQUEST);
	});

	test("returns RPC_INVALID_REQUEST for missing method", async () => {
		const resp = await captureProcessLine(JSON.stringify({ jsonrpc: "2.0", id: 1 }), dispatch);

		expect(resp).not.toBeNull();
		expect(resp?.error).toBeDefined();
		expect(resp?.error?.code).toBe(RPC_INVALID_REQUEST);
	});

	test("does not send response for notifications (no id)", async () => {
		const resp = await captureProcessLine(
			JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			dispatch,
		);

		// Notifications produce no response
		expect(resp).toBeNull();
	});

	test("ignores empty lines", async () => {
		const resp = await captureProcessLine("", dispatch);
		expect(resp).toBeNull();
	});

	test("ignores whitespace-only lines", async () => {
		const resp = await captureProcessLine("   \t  ", dispatch);
		expect(resp).toBeNull();
	});

	test("sends RPC_INTERNAL_ERROR when dispatch throws", async () => {
		const failingDispatch = async () => {
			throw new Error("dispatch exploded");
		};

		const resp = await captureProcessLine(
			JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: {} }),
			failingDispatch,
		);

		expect(resp).not.toBeNull();
		expect(resp?.id).toBe(99);
		expect(resp?.error).toBeDefined();
		expect(resp?.error?.code).toBe(RPC_INTERNAL_ERROR);
		expect(resp?.error?.message).toBe("dispatch exploded");
	});
});
