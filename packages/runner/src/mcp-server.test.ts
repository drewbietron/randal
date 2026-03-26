import { describe, expect, test } from "bun:test";
import type { Annotation, Job, MemoryDoc, SkillDoc } from "@randal/core";
import { McpServer } from "./mcp-server.js";
import type { McpServerConfig, McpServiceHooks, McpToolDefinition } from "./mcp-server.js";

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		enabled: false, // don't start a real server in tests
		port: 0,
		tools: ["memory_search", "context", "status", "skills", "annotate"],
		...overrides,
	};
}

function rpc(method: string, params?: Record<string, unknown>, id: number | string = 1): string {
	return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function makeJob(overrides: Partial<Job> = {}): Job {
	return {
		id: "job-1",
		status: "running",
		prompt: "Fix the bug",
		agent: "opencode",
		model: "claude-sonnet-4-20250514",
		maxIterations: 10,
		workdir: "/tmp/test",
		createdAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		completedAt: null,
		duration: null,
		iterations: { current: 3, history: [] },
		plan: [
			{ task: "Analyze bug", status: "completed" },
			{ task: "Fix bug", status: "in_progress" },
		],
		progressHistory: [],
		delegations: [],
		cost: { totalTokens: { input: 10000, output: 3000 }, estimatedCost: 0.15, wallTime: 120 },
		updates: [],
		error: null,
		exitCode: null,
		...overrides,
	};
}

function makeMemoryDoc(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
	return {
		id: "doc-1",
		type: "learning",
		file: "test.md",
		content: "test content",
		contentHash: "abc",
		category: "lesson",
		source: "self",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

// ── McpServer construction and registration ─────────────────

describe("McpServer", () => {
	test("registers builtin tools on construction", () => {
		const server = new McpServer(makeConfig());
		const tools = server.registeredTools;

		expect(tools).toContain("memory_search");
		expect(tools).toContain("context");
		expect(tools).toContain("status");
		expect(tools).toContain("skills");
		expect(tools).toContain("annotate");
	});

	test("registerTool adds a custom tool", () => {
		const server = new McpServer(makeConfig());
		const customTool: McpToolDefinition = {
			name: "custom_tool",
			description: "A custom tool",
			parameters: {
				input: { type: "string", description: "Input text", required: true },
			},
			handler: async () => "result",
		};

		server.registerTool(customTool);
		expect(server.registeredTools).toContain("custom_tool");
	});

	test("isRunning is false when server not started", () => {
		const server = new McpServer(makeConfig());
		expect(server.isRunning).toBe(false);
	});
});

// ── handleRequest — JSON-RPC dispatch ───────────────────────

describe("handleRequest", () => {
	test("returns parse error for invalid JSON", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest("not valid json{{{");

		expect(response.jsonrpc).toBe("2.0");
		expect(response.error).toBeDefined();
		expect(response.error?.code).toBe(-32700);
		expect(response.error?.message).toContain("Invalid JSON");
	});

	test("returns invalid request for missing jsonrpc field", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(JSON.stringify({ id: 1, method: "ping" }));

		expect(response.error).toBeDefined();
		expect(response.error?.code).toBe(-32600);
	});

	test("returns invalid request for missing method", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(JSON.stringify({ jsonrpc: "2.0", id: 1 }));

		expect(response.error).toBeDefined();
		expect(response.error?.code).toBe(-32600);
	});

	test("returns invalid request for missing id", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));

		expect(response.error).toBeDefined();
		expect(response.error?.code).toBe(-32600);
	});

	test("handles initialize method", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(rpc("initialize"));

		expect(response.error).toBeUndefined();
		const result = response.result as Record<string, unknown>;
		expect(result.protocolVersion).toBe("2024-11-05");
		expect(result.serverInfo).toBeDefined();
		expect(result.capabilities).toBeDefined();
	});

	test("handles ping method", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(rpc("ping"));

		expect(response.error).toBeUndefined();
		expect(response.result).toEqual({});
	});

	test("handles tools/list method", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(rpc("tools/list"));

		expect(response.error).toBeUndefined();
		const result = response.result as { tools: Array<{ name: string }> };
		expect(result.tools.length).toBeGreaterThan(0);

		const names = result.tools.map((t) => t.name);
		expect(names).toContain("memory_search");
		expect(names).toContain("status");
	});

	test("tools/list only returns enabled tools", async () => {
		const config = makeConfig({ tools: ["memory_search", "status"] });
		const server = new McpServer(config);
		const response = await server.handleRequest(rpc("tools/list"));

		const result = response.result as { tools: Array<{ name: string }> };
		const names = result.tools.map((t) => t.name);
		expect(names).toContain("memory_search");
		expect(names).toContain("status");
		expect(names).not.toContain("context");
		expect(names).not.toContain("skills");
		expect(names).not.toContain("annotate");
	});

	test("returns error for unknown method", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(rpc("nonexistent/method"));

		expect(response.error).toBeDefined();
		expect(response.error?.code).toBe(-32601);
		expect(response.error?.message).toContain("Unknown method");
	});

	test("tools/call returns error for missing tool name", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(rpc("tools/call", {}));

		expect(response.error).toBeDefined();
		expect(response.error?.code).toBe(-32602);
		expect(response.error?.message).toContain("Missing tool name");
	});

	test("tools/call returns error for unknown tool", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(rpc("tools/call", { name: "nonexistent_tool" }));

		expect(response.error).toBeDefined();
		expect(response.error?.code).toBe(-32601);
		expect(response.error?.message).toContain("Unknown tool");
	});

	test("tools/call returns error for disabled tool", async () => {
		const config = makeConfig({ tools: ["memory_search"] }); // only memory_search enabled
		const server = new McpServer(config);
		const response = await server.handleRequest(rpc("tools/call", { name: "status" }));

		expect(response.error).toBeDefined();
		expect(response.error?.code).toBe(-32601);
		expect(response.error?.message).toContain("disabled");
	});

	test("tools/call invokes handler and returns result", async () => {
		const config = makeConfig({ tools: ["custom"] });
		const server = new McpServer(config);
		server.registerTool({
			name: "custom",
			description: "Custom tool",
			parameters: {},
			handler: async () => "hello from custom tool",
		});

		const response = await server.handleRequest(
			rpc("tools/call", { name: "custom", arguments: {} }),
		);

		expect(response.error).toBeUndefined();
		const result = response.result as { content: Array<{ type: string; text: string }> };
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toBe("hello from custom tool");
	});

	test("tools/call wraps object results as JSON", async () => {
		const config = makeConfig({ tools: ["custom"] });
		const server = new McpServer(config);
		server.registerTool({
			name: "custom",
			description: "Custom tool",
			parameters: {},
			handler: async () => ({ key: "value", count: 42 }),
		});

		const response = await server.handleRequest(
			rpc("tools/call", { name: "custom", arguments: {} }),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.key).toBe("value");
		expect(parsed.count).toBe(42);
	});

	test("tools/call returns error result when handler throws", async () => {
		const config = makeConfig({ tools: ["failing"] });
		const server = new McpServer(config);
		server.registerTool({
			name: "failing",
			description: "Failing tool",
			parameters: {},
			handler: async () => {
				throw new Error("Something went wrong");
			},
		});

		const response = await server.handleRequest(
			rpc("tools/call", { name: "failing", arguments: {} }),
		);

		// Error is returned in the result, not as a JSON-RPC error
		expect(response.error).toBeUndefined();
		const result = response.result as { content: Array<{ text: string }>; isError: boolean };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Something went wrong");
	});

	test("preserves request id in response", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(rpc("ping", undefined, 42));
		expect(response.id).toBe(42);
	});

	test("preserves string id in response", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(rpc("ping", undefined, "req-abc"));
		expect(response.id).toBe("req-abc");
	});
});

// ── Builtin tool handlers ───────────────────────────────────

describe("builtin tools", () => {
	test("memory_search returns not available when hook missing", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(
			rpc("tools/call", { name: "memory_search", arguments: { query: "test" } }),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.message).toContain("not available");
	});

	test("memory_search calls hook and returns results", async () => {
		const hooks: McpServiceHooks = {
			memorySearch: async (query, _limit) => {
				return [makeMemoryDoc({ content: `Result for: ${query}` })];
			},
		};

		const server = new McpServer(makeConfig(), hooks);
		const response = await server.handleRequest(
			rpc("tools/call", {
				name: "memory_search",
				arguments: { query: "auth patterns", limit: 3 },
			}),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as {
			results: Array<{ id: string; content: string }>;
		};
		expect(parsed.results).toHaveLength(1);
		expect(parsed.results[0].id).toBe("doc-1");
		expect(parsed.results[0].content).toContain("auth patterns");
	});

	test("context returns not available when hook missing", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(
			rpc("tools/call", {
				name: "context",
				arguments: { text: "some context", workdir: "/tmp" },
			}),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain("not available");
	});

	test("context calls hook and returns success", async () => {
		let capturedText = "";
		let capturedWorkdir = "";
		const hooks: McpServiceHooks = {
			writeContext: async (workdir, text) => {
				capturedWorkdir = workdir;
				capturedText = text;
			},
		};

		const server = new McpServer(makeConfig(), hooks);
		const response = await server.handleRequest(
			rpc("tools/call", {
				name: "context",
				arguments: { text: "injected info", workdir: "/proj" },
			}),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(capturedText).toBe("injected info");
		expect(capturedWorkdir).toBe("/proj");
	});

	test("status returns not available when hooks missing", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(
			rpc("tools/call", { name: "status", arguments: {} }),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.message).toContain("not available");
	});

	test("status returns active jobs", async () => {
		const job = makeJob();
		const hooks: McpServiceHooks = {
			getActiveJobs: () => [job],
		};

		const server = new McpServer(makeConfig(), hooks);
		const response = await server.handleRequest(
			rpc("tools/call", { name: "status", arguments: {} }),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as {
			activeJobs: number;
			jobs: Array<{ id: string; status: string }>;
		};
		expect(parsed.activeJobs).toBe(1);
		expect(parsed.jobs).toHaveLength(1);
		expect(parsed.jobs[0].id).toBe("job-1");
		expect(parsed.jobs[0].status).toBe("running");
	});

	test("status returns specific job by id", async () => {
		const job = makeJob({ id: "specific-job" });
		const hooks: McpServiceHooks = {
			getJob: (id) => (id === "specific-job" ? job : undefined),
		};

		const server = new McpServer(makeConfig(), hooks);
		const response = await server.handleRequest(
			rpc("tools/call", { name: "status", arguments: { jobId: "specific-job" } }),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as { id: string };
		expect(parsed.id).toBe("specific-job");
	});

	test("status returns error for unknown job id", async () => {
		const hooks: McpServiceHooks = {
			getJob: () => undefined,
		};

		const server = new McpServer(makeConfig(), hooks);
		const response = await server.handleRequest(
			rpc("tools/call", { name: "status", arguments: { jobId: "missing-job" } }),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as { error: string };
		expect(parsed.error).toContain("not found");
	});

	test("skills returns not available when hook missing", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(
			rpc("tools/call", { name: "skills", arguments: { query: "testing" } }),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.message).toContain("not available");
	});

	test("skills calls hook and returns results", async () => {
		const hooks: McpServiceHooks = {
			searchSkills: async (_query, _limit) => {
				return [
					{
						meta: {
							name: "test-skill",
							description: "A testing skill",
							tags: ["testing"],
						},
						content: "skill content here",
						filePath: "/skills/test.md",
						updated: new Date().toISOString(),
					} as SkillDoc,
				];
			},
		};

		const server = new McpServer(makeConfig(), hooks);
		const response = await server.handleRequest(
			rpc("tools/call", { name: "skills", arguments: { query: "testing" } }),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as {
			results: Array<{ name: string; description: string }>;
		};
		expect(parsed.results).toHaveLength(1);
		expect(parsed.results[0].name).toBe("test-skill");
		expect(parsed.results[0].description).toBe("A testing skill");
	});

	test("annotate returns not available when hooks missing", async () => {
		const server = new McpServer(makeConfig());
		const response = await server.handleRequest(
			rpc("tools/call", {
				name: "annotate",
				arguments: { jobId: "job-1", verdict: "pass" },
			}),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.success).toBe(false);
		expect(parsed.message).toContain("not available");
	});

	test("annotate returns error for unknown job", async () => {
		const hooks: McpServiceHooks = {
			addAnnotation: async (ann) =>
				({ ...ann, id: "ann-1", timestamp: new Date().toISOString() }) as Annotation,
			getJob: () => undefined,
		};

		const server = new McpServer(makeConfig(), hooks);
		const response = await server.handleRequest(
			rpc("tools/call", {
				name: "annotate",
				arguments: { jobId: "missing", verdict: "pass" },
			}),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain("not found");
	});

	test("annotate succeeds with valid job", async () => {
		const job = makeJob({ id: "job-1" });
		let capturedAnnotation: Record<string, unknown> | null = null;

		const hooks: McpServiceHooks = {
			getJob: (id) => (id === "job-1" ? job : undefined),
			addAnnotation: async (ann) => {
				capturedAnnotation = ann as unknown as Record<string, unknown>;
				return { ...ann, id: "ann-1", timestamp: new Date().toISOString() } as Annotation;
			},
		};

		const server = new McpServer(makeConfig(), hooks);
		const response = await server.handleRequest(
			rpc("tools/call", {
				name: "annotate",
				arguments: { jobId: "job-1", verdict: "pass", feedback: "Great work" },
			}),
		);

		const result = response.result as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.annotationId).toBe("ann-1");
		expect(capturedAnnotation).not.toBeNull();
		const annotation = capturedAnnotation as unknown as Record<string, unknown>;
		expect(annotation.verdict).toBe("pass");
		expect(annotation.feedback).toBe("Great work");
	});
});

// ── Concurrent handling ─────────────────────────────────────

describe("concurrent requests", () => {
	test("handles multiple requests in parallel", async () => {
		const server = new McpServer(makeConfig());

		const [r1, r2, r3] = await Promise.all([
			server.handleRequest(rpc("ping", undefined, 1)),
			server.handleRequest(rpc("initialize", undefined, 2)),
			server.handleRequest(rpc("tools/list", undefined, 3)),
		]);

		expect(r1.id).toBe(1);
		expect(r1.error).toBeUndefined();
		expect(r2.id).toBe(2);
		expect(r2.error).toBeUndefined();
		expect(r3.id).toBe(3);
		expect(r3.error).toBeUndefined();
	});
});
