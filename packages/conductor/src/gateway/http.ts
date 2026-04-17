/**
 * HTTP Gateway for Posse Conductor
 *
 * Hono-based HTTP server providing REST API endpoints for:
 * - Chat completions (OpenAI-compatible)
 * - Posse agent management
 * - Health monitoring
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ConductorConfig } from "../config.ts";
import type { TaskRouter } from "../router/index.ts";
import type { ChatRequest, HealthResponse, PosseCommand, PosseCommandResult } from "../types.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * HTTP Gateway configuration
 */
export interface HttpGatewayConfig {
	/** Server port */
	port: number;
	/** Server host */
	host: string;
	/** CORS configuration */
	cors?: {
		origins?: string[];
		credentials?: boolean;
	};
	/** Authentication token (optional) */
	authToken?: string;
	/** Request timeout in ms (default: 120000) */
	timeout?: number;
}

/**
 * Task submission result
 */
export interface TaskResult {
	/** Task ID */
	id: string;
	/** Task status */
	status: "pending" | "processing" | "completed" | "failed";
	/** Response data (if completed) */
	response?: unknown;
	/** Error message (if failed) */
	error?: string;
	/** Timestamp */
	timestamp: string;
}

/**
 * HTTP Gateway instance
 */
export interface HttpGateway {
	/** Hono app instance */
	app: Hono;
	/** Start the server */
	start(): Promise<void>;
	/** Stop the server */
	stop(): Promise<void>;
	/** Get server port */
	getPort(): number;
	/** Check if server is running */
	isRunning(): boolean;
	/** Get the Bun server instance (for SSE access) */
	getServer(): ReturnType<typeof Bun.serve> | null;
}

// ============================================================================
// Server Factory
// ============================================================================

/**
 * Create HTTP server with all routes and middleware
 */
export function createHttpServer(
	config: ConductorConfig,
	registry?: AgentRegistry,
	router?: TaskRouter,
	sseApp?: Hono,
): HttpGateway {
	const gatewayConfig: HttpGatewayConfig = {
		port: config.server.port,
		host: config.server.host,
		authToken: config.gateway.http.auth || undefined,
		timeout: 120000,
		cors: {
			origins: ["*"],
			credentials: true,
		},
	};

	const app = new Hono();

	// CORS middleware
	app.use("*", cors({ origin: "*" }));

	// Request logging middleware
	app.use("*", async (c, next) => {
		const startTime = Date.now();
		await next();
		const duration = Date.now() - startTime;
		const timestamp = new Date().toISOString();
		console.log(`[${timestamp}] ${c.req.method} ${c.req.path} ${c.res.status} - ${duration}ms`);
	});

	// ========================================================================
	// Public routes (before auth middleware)
	// ========================================================================

	app.get("/health", async (c) => {
		const stats = registry?.getStats() ?? {
			total: 0,
			online: 0,
			offline: 0,
			busy: 0,
			error: 0,
		};

		// Determine overall health
		let status: "healthy" | "degraded" | "unhealthy" = "healthy";
		if (stats.total === 0) {
			status = config.mode === "posse" ? "unhealthy" : "healthy";
		} else if (stats.online === 0 && stats.busy === 0) {
			status = "unhealthy";
		} else if (stats.offline > 0 || stats.error > 0) {
			status = "degraded";
		}

		const response: HealthResponse = {
			status,
			mode: config.mode,
			agents: stats,
			version: "0.1.0",
			timestamp: new Date().toISOString(),
		};

		return c.json(response, status === "unhealthy" ? 503 : 200);
	});

	// ========================================================================
	// Authentication middleware (for all routes below)
	// ========================================================================

	app.use("*", async (c, next) => {
		// Skip public routes that were already matched
		if (c.req.path === "/health") {
			return next();
		}

		const authToken = gatewayConfig.authToken;
		if (!authToken) {
			return next();
		}

		const header = c.req.header("Authorization");
		if (!header) {
			return c.json(
				{
					error: "Authorization required",
					code: "UNAUTHORIZED",
					message: "Missing Authorization header",
				},
				401,
			);
		}

		const parts = header.split(" ");
		if (parts.length !== 2 || parts[0] !== "Bearer") {
			return c.json(
				{
					error: "Invalid authorization format",
					code: "UNAUTHORIZED",
					message: 'Expected "Bearer <token>" format',
				},
				401,
			);
		}

		if (parts[1] !== authToken) {
			return c.json(
				{
					error: "Invalid token",
					code: "UNAUTHORIZED",
					message: "The provided token is invalid",
				},
				401,
			);
		}

		return next();
	});

	// ========================================================================
	// Protected routes
	// ========================================================================

	app.post("/v1/chat", async (c) => {
		try {
			const chatRequest = await c.req.json<ChatRequest>();

			// Validate request
			if (!chatRequest.messages || !Array.isArray(chatRequest.messages)) {
				return c.json(
					{
						error: "Invalid request",
						code: "VALIDATION_ERROR",
						message: "messages array is required",
					},
					400,
				);
			}

			// Route to the TaskRouter if available
			if (router) {
				try {
					const result = await router.routeTask({
						id: crypto.randomUUID(),
						content: chatRequest.messages[chatRequest.messages.length - 1]?.content ?? "",
						channel: "http",
						userId: "anonymous",
						timestamp: new Date().toISOString(),
						explicitAgent: chatRequest.agent,
						metadata: {
							model: chatRequest.model,
							stream: chatRequest.stream,
							temperature: chatRequest.temperature,
							max_tokens: chatRequest.max_tokens,
							originalMessages: chatRequest.messages,
						},
					});
					// Wrap in TaskResult format for backward compat
					return c.json({
						id: result.taskId,
						status: result.success ? "completed" : "failed",
						response: result,
						timestamp: new Date().toISOString(),
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return c.json(
						{
							error: message,
							code: "ROUTING_ERROR",
							message,
						},
						502,
					);
				}
			}

			// Fallback if no router
			return c.json(
				{
					error: "No router configured",
					code: "SERVICE_UNAVAILABLE",
					message: "No router configured",
				},
				503,
			);
		} catch (err) {
			// JSON parse errors etc.
			const message = err instanceof Error ? err.message : String(err);
			return c.json(
				{
					error: message,
					code: "BAD_REQUEST",
					message,
				},
				400,
			);
		}
	});

	// Posse-only routes
	app.get("/posse/agents", (c) => {
		if (config.mode !== "posse") {
			return c.json(
				{
					error: "Not available in single mode",
					code: "FORBIDDEN",
					message: "Posse endpoints only available in posse mode",
				},
				403,
			);
		}

		if (!registry) {
			return c.json(
				{
					error: "Registry not available",
					code: "SERVICE_UNAVAILABLE",
					message: "Agent registry is not initialized",
				},
				503,
			);
		}

		const agents = registry.getAllAgents();
		return c.json({
			agents,
			total: agents.length,
			timestamp: new Date().toISOString(),
		});
	});

	app.post("/posse/command", async (c) => {
		if (config.mode !== "posse") {
			return c.json(
				{
					error: "Not available in single mode",
					code: "FORBIDDEN",
					message: "Posse endpoints only available in posse mode",
				},
				403,
			);
		}

		if (!registry) {
			return c.json(
				{
					error: "Registry not available",
					code: "SERVICE_UNAVAILABLE",
					message: "Agent registry is not initialized",
				},
				503,
			);
		}

		const command = await c.req.json<PosseCommand>();
		const targetAgent = c.req.query("agent");

		// Validate command
		if (!command.command) {
			return c.json(
				{
					error: "Invalid command",
					code: "VALIDATION_ERROR",
					message: "command field is required",
				},
				400,
			);
		}

		// Determine target agents
		const targetNames: string[] = [];
		if (targetAgent) {
			targetNames.push(targetAgent);
		} else if (command.target === "all") {
			targetNames.push(...registry.getAllAgents().map((a) => a.name));
		} else if (command.target) {
			targetNames.push(command.target);
		}

		// Execute command on targets
		const results: Array<{ agent: string; success: boolean; message?: string; error?: string }> =
			[];

		for (const agentName of targetNames) {
			const agent = registry.getAgent(agentName);
			if (!agent) {
				results.push({
					agent: agentName,
					success: false,
					error: "Agent not found",
				});
				continue;
			}

			try {
				// TODO: Implement actual command forwarding to agents
				results.push({
					agent: agentName,
					success: true,
					message: `Command "${command.command}" accepted`,
				});
			} catch (err) {
				results.push({
					agent: agentName,
					success: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const result: PosseCommandResult = {
			command: command.command,
			targets: targetNames,
			results,
			success: results.every((r) => r.success),
		};

		return c.json(result);
	});

	app.get("/posse/health", (c) => {
		if (config.mode !== "posse") {
			return c.json(
				{
					error: "Not available in single mode",
					code: "FORBIDDEN",
					message: "Posse endpoints only available in posse mode",
				},
				403,
			);
		}

		if (!registry) {
			return c.json(
				{
					error: "Registry not available",
					code: "SERVICE_UNAVAILABLE",
					message: "Agent registry is not initialized",
				},
				503,
			);
		}

		const agents = registry.getAllAgents();
		const stats = registry.getStats();

		return c.json({
			posse: {
				name: registry.getPosseName(),
				mode: config.mode,
			},
			conductor: {
				status: stats.online > 0 || stats.busy > 0 ? "healthy" : "unhealthy",
				version: "0.1.0",
				timestamp: new Date().toISOString(),
			},
			agents: {
				stats,
				details: agents.map((agent) => ({
					name: agent.name,
					status: agent.status,
					health: agent.health,
					endpoint: agent.endpoint,
					models: agent.models,
					capabilities: agent.capabilities,
				})),
			},
		});
	});

	// ========================================================================
	// SSE events sub-router (mounted before catch-all so /events is reachable)
	// ========================================================================

	if (sseApp) {
		app.route("/", sseApp);
	}

	// ========================================================================
	// Catch-all for 404
	// ========================================================================

	app.all("*", (c) => {
		return c.json(
			{
				error: "Not found",
				code: "NOT_FOUND",
				message: `Cannot ${c.req.method} ${c.req.path}`,
			},
			404,
		);
	});

	// ========================================================================
	// Server lifecycle
	// ========================================================================

	let server: ReturnType<typeof Bun.serve> | null = null;
	let running = false;
	let actualPort: number = gatewayConfig.port;

	return {
		app,

		async start(): Promise<void> {
			if (running) {
				console.warn("HTTP server already running");
				return;
			}

			server = Bun.serve({
				port: gatewayConfig.port,
				hostname: gatewayConfig.host,
				fetch: app.fetch,
			});

			running = true;
			actualPort = server.port ?? gatewayConfig.port;
			console.log(`HTTP Gateway listening on http://${gatewayConfig.host}:${actualPort}`);
		},

		async stop(): Promise<void> {
			if (!running || !server) {
				return;
			}

			server.stop();
			running = false;
			server = null;
			console.log("HTTP Gateway stopped");
		},

		getPort(): number {
			return actualPort;
		},

		isRunning(): boolean {
			return running;
		},

		getServer(): ReturnType<typeof Bun.serve> | null {
			return server;
		},
	};
}
