/**
 * Shared JSON-RPC 2.0 transport layer for MCP stdio servers.
 *
 * Provides types, error codes, ToolError, and the full stdin/stdout transport
 * so individual MCP servers only need to supply tool definitions + handlers.
 */

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// ToolError — thrown by handlers for user-facing validation errors
// ---------------------------------------------------------------------------

export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

// ---------------------------------------------------------------------------
// Tool definition type
// ---------------------------------------------------------------------------

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// createDispatcher — builds a dispatch() function from server info + tools
// ---------------------------------------------------------------------------

export interface DispatcherConfig {
	serverName: string;
	serverVersion: string;
	protocolVersion?: string;
	tools: ToolDefinition[];
	handlers: Record<string, ToolHandler>;
}

/**
 * Create a JSON-RPC dispatch function from server metadata and tool registrations.
 *
 * Handles: initialize, notifications/initialized, ping, tools/list, tools/call,
 * and unknown methods.
 *
 * Returns `null` for notifications (no response needed).
 */
export function createDispatcher(config: DispatcherConfig) {
	const {
		serverName,
		serverVersion,
		protocolVersion = "2024-11-05",
		tools,
		handlers,
	} = config;

	return async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
		const { id, method, params } = req;

		// --- initialize ---
		if (method === "initialize") {
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion,
					serverInfo: { name: serverName, version: serverVersion },
					capabilities: {
						tools: { listChanged: false },
					},
				},
			};
		}

		// --- notifications/initialized ---
		if (method === "notifications/initialized") {
			return null;
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
				result: { tools },
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

			const handler = handlers[callParams.name];
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
	};
}

// ---------------------------------------------------------------------------
// Transport utilities
// ---------------------------------------------------------------------------

/**
 * Write a JSON-RPC response to stdout.
 */
export function send(response: JsonRpcResponse): void {
	const line = `${JSON.stringify(response)}\n`;
	process.stdout.write(line);
}

/**
 * Log a message to stderr (never stdout, which is reserved for JSON-RPC).
 */
export function log(level: "info" | "warn" | "error", message: string): void {
	const ts = new Date().toISOString();
	process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${message}\n`);
}

/**
 * Process a single line of input as a JSON-RPC request.
 * Parses JSON, validates the JSON-RPC envelope, calls dispatch, and sends responses.
 */
export async function processLine(
	line: string,
	dispatch: (req: JsonRpcRequest) => Promise<JsonRpcResponse | null>,
): Promise<void> {
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
// runStdioTransport — the main stdin line reader loop
// ---------------------------------------------------------------------------

export interface StdioTransportOptions {
	/** Server name for startup log message. */
	serverName: string;
	/** Called before the stdin read loop begins. */
	onStart?: () => Promise<void> | void;
	/** The dispatch function (from createDispatcher or custom). */
	dispatch: (req: JsonRpcRequest) => Promise<JsonRpcResponse | null>;
}

/**
 * Run the MCP stdio transport: read newline-delimited JSON-RPC from stdin,
 * dispatch each request, and write responses to stdout.
 */
export async function runStdioTransport(options: StdioTransportOptions): Promise<void> {
	const { serverName, onStart, dispatch } = options;

	log("info", `${serverName} MCP server starting`);

	if (onStart) {
		await onStart();
	}

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

			// Process complete lines
			let newlineIdx: number = buffer.indexOf("\n");
			while (newlineIdx !== -1) {
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				await processLine(line, dispatch);
				newlineIdx = buffer.indexOf("\n");
			}
		}

		// Process any remaining data in the buffer (no trailing newline)
		if (buffer.trim()) {
			await processLine(buffer, dispatch);
		}
	} catch (err) {
		// stdin closed or read error — exit cleanly
		const message = err instanceof Error ? err.message : String(err);
		log("info", `stdin closed: ${message}`);
	}

	log("info", "MCP server shutting down");
}

/**
 * Convenience: create dispatcher + run transport in one call.
 * The entrypoint for most MCP servers.
 */
export function startMcpServer(
	config: DispatcherConfig & {
		onStart?: () => Promise<void> | void;
	},
): void {
	const dispatch = createDispatcher(config);
	runStdioTransport({
		serverName: config.serverName,
		onStart: config.onStart,
		dispatch,
	}).catch((err) => {
		log("error", `Fatal: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
