import { getPrimaryDomain } from "@randal/analytics";
import { type RandalConfig, createLogger } from "@randal/core";
import type {
	Annotation,
	AnnotationVerdict,
	Job,
	JobIteration,
	JobPlanTask,
	MemoryDoc,
	SkillDoc,
} from "@randal/core";

const logger = createLogger({ context: { component: "mcp-server" } });

// ---- JSON-RPC types ----

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

// ---- Tool registration ----

export interface McpToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, ToolParameter>;
	handler: (params: Record<string, unknown>) => Promise<unknown>;
}

interface ToolParameter {
	type: string;
	description: string;
	required?: boolean;
}

// ---- MCP server config ----

export interface McpServerConfig {
	enabled: boolean;
	port: number;
	tools: string[];
}

// ---- External service hooks ----

/**
 * Callbacks that the MCP server uses to query Randal internals.
 * These are injected at construction so the server does not depend
 * on concrete runner / memory / skill implementations.
 */
export interface McpServiceHooks {
	memorySearch?: (query: string, limit: number) => Promise<MemoryDoc[]>;
	writeContext?: (workdir: string, text: string) => Promise<void>;
	getActiveJobs?: () => Job[];
	getJob?: (jobId: string) => Job | undefined;
	searchSkills?: (query: string, limit: number) => Promise<SkillDoc[]>;
	addAnnotation?: (annotation: Omit<Annotation, "id" | "timestamp">) => Promise<Annotation>;
}

// ---- JSON-RPC error codes ----

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

// ---- MCP Server ----

export class McpServer {
	private server: ReturnType<typeof Bun.serve> | null = null;
	private tools = new Map<string, McpToolDefinition>();
	private config: McpServerConfig;
	private hooks: McpServiceHooks;
	private connections = 0;

	constructor(config: McpServerConfig, hooks: McpServiceHooks = {}) {
		this.config = config;
		this.hooks = hooks;
		this.registerBuiltinTools();
	}

	/**
	 * Create an McpServer from a full RandalConfig, extracting the relevant
	 * section and wiring defaults.
	 */
	static fromConfig(config: RandalConfig, hooks: McpServiceHooks = {}): McpServer {
		const mcpCfg = config.runner.mcpServer;
		return new McpServer(
			{
				enabled: mcpCfg.enabled,
				port: mcpCfg.port,
				tools: mcpCfg.tools,
			},
			hooks,
		);
	}

	// ---- Lifecycle ----

	async start(port?: number): Promise<void> {
		const listenPort = port ?? this.config.port;

		if (!this.config.enabled) {
			logger.info("MCP server disabled by config");
			return;
		}

		this.server = Bun.serve({
			port: listenPort,
			fetch: async (req) => {
				return this.handleHttp(req);
			},
		});

		logger.info("MCP server started", {
			port: listenPort,
			tools: [...this.tools.keys()],
		});
	}

	async stop(): Promise<void> {
		if (this.server) {
			this.server.stop();
			this.server = null;
			logger.info("MCP server stopped");
		}
	}

	// ---- HTTP handling ----

	private async handleHttp(req: Request): Promise<Response> {
		// CORS preflight
		if (req.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(),
			});
		}

		if (req.method !== "POST") {
			return jsonResponse(
				{
					jsonrpc: "2.0",
					id: null,
					error: { code: RPC_INVALID_REQUEST, message: "POST required" },
				},
				405,
			);
		}

		this.connections++;
		try {
			const body = await req.text();
			const response = await this.handleRequest(body);
			return jsonResponse(response, 200);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("Unhandled error in MCP request", { error: message });
			return jsonResponse(
				{ jsonrpc: "2.0", id: null, error: { code: RPC_INTERNAL_ERROR, message } },
				500,
			);
		} finally {
			this.connections--;
		}
	}

	// ---- JSON-RPC dispatch ----

	async handleRequest(raw: string): Promise<JsonRpcResponse> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				jsonrpc: "2.0",
				id: 0,
				error: { code: RPC_PARSE_ERROR, message: "Invalid JSON" },
			};
		}

		const req = parsed as Partial<JsonRpcRequest>;
		if (!req.jsonrpc || req.jsonrpc !== "2.0" || !req.method || req.id == null) {
			return {
				jsonrpc: "2.0",
				id: req.id ?? 0,
				error: { code: RPC_INVALID_REQUEST, message: "Invalid JSON-RPC request" },
			};
		}

		const id = req.id;

		// Built-in discovery methods
		if (req.method === "tools/list") {
			return {
				jsonrpc: "2.0",
				id,
				result: {
					tools: this.listToolDescriptions(),
				},
			};
		}

		if (req.method === "tools/call") {
			const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
			if (!params.name) {
				return {
					jsonrpc: "2.0",
					id,
					error: { code: RPC_INVALID_PARAMS, message: "Missing tool name in params.name" },
				};
			}
			return this.invokeTool(id, params.name, params.arguments ?? {});
		}

		if (req.method === "initialize") {
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2024-11-05",
					serverInfo: { name: "randal-mcp", version: "0.1.0" },
					capabilities: {
						tools: { listChanged: false },
					},
				},
			};
		}

		if (req.method === "ping") {
			return { jsonrpc: "2.0", id, result: {} };
		}

		return {
			jsonrpc: "2.0",
			id,
			error: { code: RPC_METHOD_NOT_FOUND, message: `Unknown method: ${req.method}` },
		};
	}

	// ---- Tool invocation ----

	private async invokeTool(
		id: string | number,
		name: string,
		args: Record<string, unknown>,
	): Promise<JsonRpcResponse> {
		const tool = this.tools.get(name);
		if (!tool) {
			return {
				jsonrpc: "2.0",
				id,
				error: { code: RPC_METHOD_NOT_FOUND, message: `Unknown tool: ${name}` },
			};
		}

		// Check if tool is enabled in config
		if (!this.config.tools.includes(name)) {
			return {
				jsonrpc: "2.0",
				id,
				error: { code: RPC_METHOD_NOT_FOUND, message: `Tool disabled: ${name}` },
			};
		}

		try {
			logger.debug("Invoking tool", { tool: name, args });
			const result = await tool.handler(args);
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
			logger.warn("Tool invocation failed", { tool: name, error: message });
			return {
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
				},
			};
		}
	}

	// ---- Tool registration ----

	registerTool(tool: McpToolDefinition): void {
		this.tools.set(tool.name, tool);
		logger.debug("Tool registered", { tool: tool.name });
	}

	private listToolDescriptions(): Array<{
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
	}> {
		const enabled = this.config.tools;
		return [...this.tools.values()]
			.filter((t) => enabled.includes(t.name))
			.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: {
					type: "object",
					properties: Object.fromEntries(
						Object.entries(t.parameters).map(([key, param]) => [
							key,
							{ type: param.type, description: param.description },
						]),
					),
					required: Object.entries(t.parameters)
						.filter(([, p]) => p.required)
						.map(([k]) => k),
				},
			}));
	}

	// ---- Builtin tools ----

	private registerBuiltinTools(): void {
		this.registerTool({
			name: "memory_search",
			description:
				"Search Randal's long-term memory for relevant context, past learnings, patterns, and preferences.",
			parameters: {
				query: { type: "string", description: "Search query text", required: true },
				limit: { type: "number", description: "Maximum results to return (default 5)" },
			},
			handler: async (params) => {
				const query = params.query as string;
				const limit = (params.limit as number) ?? 5;

				if (!this.hooks.memorySearch) {
					return { results: [], message: "Memory search not available" };
				}

				const results = await this.hooks.memorySearch(query, limit);
				return {
					results: results.map((doc) => ({
						id: doc.id,
						type: doc.type,
						category: doc.category,
						content: doc.content,
						source: doc.source,
						timestamp: doc.timestamp,
					})),
				};
			},
		});

		this.registerTool({
			name: "context",
			description:
				"Inject context into the running Randal job. The text will be included in the next iteration's prompt.",
			parameters: {
				text: { type: "string", description: "Context text to inject", required: true },
				workdir: {
					type: "string",
					description: "Working directory of the target job",
					required: true,
				},
			},
			handler: async (params) => {
				const text = params.text as string;
				const workdir = params.workdir as string;

				if (!this.hooks.writeContext) {
					return { success: false, message: "Context injection not available" };
				}

				await this.hooks.writeContext(workdir, text);
				return { success: true, message: "Context injected" };
			},
		});

		this.registerTool({
			name: "status",
			description:
				"Get the current status of Randal jobs. Returns active jobs with their plan progress, iteration count, and cost.",
			parameters: {
				jobId: { type: "string", description: "Specific job ID to query (optional)" },
			},
			handler: async (params) => {
				const jobId = params.jobId as string | undefined;

				if (jobId && this.hooks.getJob) {
					const job = this.hooks.getJob(jobId);
					if (!job) {
						return { error: `Job not found: ${jobId}` };
					}
					return formatJobStatus(job);
				}

				if (!this.hooks.getActiveJobs) {
					return { jobs: [], message: "Status not available" };
				}

				const jobs = this.hooks.getActiveJobs();
				return {
					activeJobs: jobs.length,
					jobs: jobs.map(formatJobStatus),
				};
			},
		});

		this.registerTool({
			name: "skills",
			description: "Search available Randal skills. Returns skill documents matching the query.",
			parameters: {
				query: { type: "string", description: "Search query for skills", required: true },
				limit: { type: "number", description: "Maximum results (default 5)" },
			},
			handler: async (params) => {
				const query = params.query as string;
				const limit = (params.limit as number) ?? 5;

				if (!this.hooks.searchSkills) {
					return { results: [], message: "Skill search not available" };
				}

				const results = await this.hooks.searchSkills(query, limit);
				return {
					results: results.map((skill) => ({
						name: skill.meta.name,
						description: skill.meta.description,
						tags: skill.meta.tags ?? [],
						content: skill.content,
					})),
				};
			},
		});

		this.registerTool({
			name: "annotate",
			description:
				"Submit a quality annotation for a completed job. Used to track agent reliability and feed the analytics loop.",
			parameters: {
				jobId: { type: "string", description: "Job ID to annotate", required: true },
				verdict: {
					type: "string",
					description: 'Annotation verdict: "pass", "fail", or "partial"',
					required: true,
				},
				feedback: { type: "string", description: "Optional feedback text" },
				categories: {
					type: "array",
					description: "Optional category tags for the annotation",
				},
			},
			handler: async (params) => {
				const jobId = params.jobId as string;
				const verdict = params.verdict as AnnotationVerdict;
				const feedback = params.feedback as string | undefined;
				const categories = params.categories as string[] | undefined;

				if (!this.hooks.addAnnotation || !this.hooks.getJob) {
					return { success: false, message: "Annotation not available" };
				}

				const job = this.hooks.getJob(jobId);
				if (!job) {
					return { success: false, error: `Job not found: ${jobId}` };
				}

				const annotation = await this.hooks.addAnnotation({
					jobId,
					verdict,
					feedback,
					categories,
					agent: job.agent,
					model: job.model,
					domain: getPrimaryDomain(job.prompt),
					iterationCount: job.iterations.current,
					tokenCost: job.cost.estimatedCost,
					duration: job.cost.wallTime,
					filesChanged: job.iterations.history.flatMap((it: JobIteration) => it.filesChanged),
					prompt: job.prompt,
				});

				return { success: true, annotationId: annotation.id };
			},
		});
	}

	// ---- Introspection ----

	get activeConnections(): number {
		return this.connections;
	}

	get registeredTools(): string[] {
		return [...this.tools.keys()];
	}

	get isRunning(): boolean {
		return this.server !== null;
	}
}

// ---- Helpers ----

function formatJobStatus(job: Job): Record<string, unknown> {
	const completedTasks = job.plan.filter((t: JobPlanTask) => t.status === "completed").length;
	return {
		id: job.id,
		status: job.status,
		agent: job.agent,
		model: job.model,
		iteration: job.iterations.current,
		maxIterations: job.maxIterations,
		plan: {
			total: job.plan.length,
			completed: completedTasks,
			tasks: job.plan.map((t: JobPlanTask) => ({ task: t.task, status: t.status })),
		},
		cost: job.cost,
		duration: job.duration,
		delegations: job.delegations.length,
	};
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			...corsHeaders(),
		},
	});
}
