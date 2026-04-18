/**
 * Integration tests for posse delegation tools.
 *
 * Requires a running Meilisearch instance. Set MEILI_URL to point to it.
 * Skip with RANDAL_SKIP_MEILISEARCH=true.
 *
 * Tests:
 * 1. posse_members discovers registered agents
 * 2. delegate_task dispatches to a mock peer and polls for result
 * 3. delegate_task rejects self-delegation
 * 4. delegate_task with async returns immediately
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Server, type Subprocess, spawn } from "bun";
import { MeiliSearch } from "meilisearch";
import { resolveLocalMeilisearchTarget } from "../packages/cli/src/commands/serve.ts";

// ---------------------------------------------------------------------------
// Skip guard — probe Meilisearch availability so CI skips automatically
// ---------------------------------------------------------------------------

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7701";
const MEILI_KEY = process.env.MEILI_MASTER_KEY || "";

let SKIP = process.env.RANDAL_SKIP_MEILISEARCH === "true";
if (!SKIP) {
	try {
		const client = new MeiliSearch({ host: MEILI_URL, apiKey: MEILI_KEY || undefined });
		await client.health();
	} catch {
		SKIP = true;
	}
}

// ---------------------------------------------------------------------------
// Line-buffered MCP server wrapper
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
 * Wraps a subprocess stdout into a queue of newline-delimited JSON lines.
 * Uses a single persistent reader to avoid the lost-bytes problem.
 */
class McpClient {
	private proc: Subprocess;
	private lineQueue: string[] = [];
	private resolveWaiter: ((line: string) => void) | null = null;
	private readerDone = false;

	constructor(proc: Subprocess) {
		this.proc = proc;
		this.startReading();
	}

	/** Check if a line looks like a JSON-RPC response (has jsonrpc field). */
	private isJsonRpc(line: string): boolean {
		try {
			const obj = JSON.parse(line);
			return obj && typeof obj === "object" && obj.jsonrpc === "2.0";
		} catch {
			return false;
		}
	}

	private startReading() {
		const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		const pump = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						this.readerDone = true;
						break;
					}
					buffer += decoder.decode(value, { stream: true });
					let idx = buffer.indexOf("\n");
					while (idx !== -1) {
						const line = buffer.slice(0, idx).trim();
						buffer = buffer.slice(idx + 1);
						// Filter: only enqueue actual JSON-RPC responses, skip logger noise
						if (line && this.isJsonRpc(line)) {
							if (this.resolveWaiter) {
								const resolve = this.resolveWaiter;
								this.resolveWaiter = null;
								resolve(line);
							} else {
								this.lineQueue.push(line);
							}
						}
						idx = buffer.indexOf("\n");
					}
				}
			} catch {
				this.readerDone = true;
			}
		};

		pump();
	}

	async readLine(timeoutMs = 30000): Promise<string> {
		if (this.lineQueue.length > 0) {
			return this.lineQueue.shift() as string;
		}
		if (this.readerDone) throw new Error("Reader is done");

		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.resolveWaiter = null;
				reject(new Error(`Timeout waiting for line (${timeoutMs}ms)`));
			}, timeoutMs);

			this.resolveWaiter = (line: string) => {
				clearTimeout(timer);
				resolve(line);
			};
		});
	}

	async sendAndReceive(
		method: string,
		params: Record<string, unknown>,
		id: number,
	): Promise<JsonRpcResponse> {
		const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		const stdin = this.proc.stdin as import("bun").FileSink;
		stdin.write(`${request}\n`);
		stdin.flush();
		const line = await this.readLine();
		return JSON.parse(line) as JsonRpcResponse;
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown>,
		id: number,
	): Promise<JsonRpcResponse> {
		return this.sendAndReceive("tools/call", { name: toolName, arguments: args }, id);
	}

	kill() {
		this.proc.kill();
	}
}

function parseToolResult(resp: JsonRpcResponse): unknown {
	const text = resp.result?.content?.[0]?.text;
	if (!text) throw new Error(`No text content in response: ${JSON.stringify(resp)}`);
	return JSON.parse(text);
}

async function startClient(envOverrides: Record<string, string> = {}): Promise<McpClient> {
	const proc = spawn(["bun", "run", "tools/mcp-memory/index.ts"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			RANDAL_SKIP_MEILISEARCH: "true",
			MEILI_URL,
			MEILI_MASTER_KEY: MEILI_KEY,
			...envOverrides,
		},
		cwd: import.meta.dir.replace(/\/tools$/, ""),
	});

	const client = new McpClient(proc);

	// Initialize handshake
	await client.sendAndReceive("initialize", {}, 0);

	// Allow background init to settle
	await Bun.sleep(2000);
	return client;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_POSSE = `test-posse-${Date.now()}`;
const TEST_INDEX = `posse-registry-${TEST_POSSE}`;
const SELF_NAME = "integration-self";
const PEER_NAME = "integration-peer";

function resolveMemoryTypesInSubprocess(env: Record<string, string>): { url: string; key: string } {
	const proc = Bun.spawnSync(
		[
			"bun",
			"--eval",
			'const mod = await import("./tools/mcp-memory/types.ts"); console.log(JSON.stringify({ url: mod.MEILI_URL, key: mod.MEILI_MASTER_KEY }));',
		],
		{
			cwd: import.meta.dir.replace(/\/tools$/, ""),
			env: {
				...process.env,
				...env,
			},
		},
	);

	if (proc.exitCode !== 0) {
		throw new Error(proc.stderr.toString() || "failed to resolve memory types in subprocess");
	}

	return JSON.parse(proc.stdout.toString()) as { url: string; key: string };
}

describe("local Meilisearch resolution", () => {
	test("shared tools/mcp-memory defaults to localhost:7701", () => {
		const resolved = resolveMemoryTypesInSubprocess({
			MEILI_URL: "",
			MEILI_MASTER_KEY: "",
			MEILI_API_KEY: "",
		});

		expect(resolved.url).toBe("http://localhost:7701");
		expect(resolved.key).toBe("");
	});

	test("shared tools/mcp-memory honors explicit localhost:7700 override and legacy auth", () => {
		const resolved = resolveMemoryTypesInSubprocess({
			MEILI_URL: "http://localhost:7700",
			MEILI_MASTER_KEY: "",
			MEILI_API_KEY: "legacy-key",
		});

		expect(resolved.url).toBe("http://localhost:7700");
		expect(resolved.key).toBe("legacy-key");
	});

	test("serve CLI derives local host port from canonical localhost URL", () => {
		expect(resolveLocalMeilisearchTarget("http://localhost:7701")).toEqual({
			hostname: "localhost",
			port: 7701,
			httpAddr: "localhost:7701",
			dockerPublish: "7701:7700",
		});
		expect(resolveLocalMeilisearchTarget("http://127.0.0.1:7700")).toEqual({
			hostname: "127.0.0.1",
			port: 7700,
			httpAddr: "127.0.0.1:7700",
			dockerPublish: "127.0.0.1:7700:7700",
		});
	});

	test("serve CLI skips local Docker inference for remote endpoints", () => {
		expect(resolveLocalMeilisearchTarget("https://meili.internal:7700")).toBeNull();
		expect(resolveLocalMeilisearchTarget("http://192.168.1.10:7701")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("posse integration", () => {
	let meili: MeiliSearch;
	let mockServer: Server<unknown>;
	let mockPort = 0;
	let client: McpClient;

	// Track job state for mock server
	const jobStore: Record<string, { status: string; summary: string }> = {};

	beforeAll(async () => {
		// 1. Verify Meilisearch is reachable
		meili = new MeiliSearch({ host: MEILI_URL, apiKey: MEILI_KEY || undefined });
		await meili.health();

		// 2. Start a mock peer gateway
		mockServer = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const url = new URL(req.url);

				if (url.pathname === "/health") {
					return Response.json({ status: "available" });
				}

				if (req.method === "POST" && (url.pathname === "/job" || url.pathname === "/jobs")) {
					const body = (await req.json()) as { prompt: string };
					const jobId = `job-${Date.now()}`;
					jobStore[jobId] = { status: "completed", summary: `Done: ${body.prompt}` };
					return Response.json({ id: jobId });
				}

				const jobMatch = url.pathname.match(/^\/jobs?\/(.+)$/);
				if (req.method === "GET" && jobMatch) {
					const jobId = jobMatch[1];
					const job = jobStore[jobId];
					if (!job) return Response.json({ error: "not found" }, { status: 404 });
					return Response.json(job);
				}

				return Response.json({ error: "not found" }, { status: 404 });
			},
		});
		mockPort = mockServer.port ?? 0;

		// 3. Register two agents in the test posse registry
		const index = meili.index(TEST_INDEX);

		await index.addDocuments([
			{
				id: SELF_NAME,
				name: SELF_NAME,
				posse: TEST_POSSE,
				capabilities: ["run"],
				agent: "mock",
				status: "idle",
				version: "0.1",
				lastHeartbeat: new Date().toISOString(),
				registeredAt: new Date().toISOString(),
				endpoint: `http://localhost:${mockPort}`,
				specialization: "backend",
			},
		]);

		await index.addDocuments([
			{
				id: PEER_NAME,
				name: PEER_NAME,
				posse: TEST_POSSE,
				capabilities: ["run", "search"],
				agent: "mock",
				status: "idle",
				version: "0.1",
				lastHeartbeat: new Date().toISOString(),
				registeredAt: new Date().toISOString(),
				endpoint: `http://localhost:${mockPort}`,
				specialization: "frontend",
			},
		]);

		// Wait for Meilisearch to index
		await Bun.sleep(1500);

		// 4. Start MCP server with posse configured
		client = await startClient({
			RANDAL_POSSE_NAME: TEST_POSSE,
			RANDAL_SELF_NAME: SELF_NAME,
			RANDAL_GATEWAY_URL: `http://localhost:${mockPort}`,
		});
	});

	afterAll(async () => {
		client?.kill();
		mockServer?.stop();
		try {
			await meili.deleteIndex(TEST_INDEX);
		} catch {
			// Index might not exist
		}
	});

	test("posse_members discovers registered agents", async () => {
		const resp = await client.callTool("posse_members", {}, 1);
		const result = parseToolResult(resp) as {
			members: Array<{
				name: string;
				status: string;
				specialization?: string;
				capabilities: string[];
				isSelf: boolean;
			}>;
		};

		expect(result.members.length).toBeGreaterThanOrEqual(2);

		const self = result.members.find((m) => m.name === SELF_NAME);
		expect(self).toBeDefined();
		expect(self?.isSelf).toBe(true);

		const peer = result.members.find((m) => m.name === PEER_NAME);
		expect(peer).toBeDefined();
		expect(peer?.isSelf).toBe(false);
		expect(peer?.capabilities).toContain("search");
	});

	test("delegate_task dispatches to explicit peer target", async () => {
		const resp = await client.callTool(
			"delegate_task",
			{ task: "build the homepage", target: PEER_NAME },
			2,
		);
		const result = parseToolResult(resp) as {
			delegated: boolean;
			jobId?: string;
			target?: string;
			status?: string;
			summary?: string;
		};

		expect(result.delegated).toBe(true);
		expect(result.target).toBe(PEER_NAME);
		expect(result.jobId).toBeTruthy();
		expect(result.status).toBe("completed");
		expect(result.summary).toContain("build the homepage");
	});

	test("delegate_task rejects self-delegation", async () => {
		const resp = await client.callTool(
			"delegate_task",
			{ task: "some task", target: SELF_NAME },
			3,
		);
		const result = parseToolResult(resp) as { delegated: boolean; message: string };

		expect(result.delegated).toBe(false);
		expect(result.message).toContain("Cannot delegate to self");
	});

	test("delegate_task with async returns job ID", async () => {
		const resp = await client.callTool(
			"delegate_task",
			{ task: "background work", target: PEER_NAME, async: true },
			4,
		);
		const result = parseToolResult(resp) as {
			delegated: boolean;
			jobId?: string;
			status?: string;
		};

		expect(result.delegated).toBe(true);
		expect(result.jobId).toBeTruthy();
		// Async returns "submitted" — the job is dispatched but not polled
		expect(result.status).toBe("submitted");
	});
});
