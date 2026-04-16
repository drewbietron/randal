/**
 * HTTP Gateway for Posse Conductor
 *
 * Express-based HTTP server providing REST API endpoints for:
 * - Chat completions (OpenAI-compatible)
 * - Posse agent management
 * - Health monitoring
 */

import cors from "cors";
import express, { type NextFunction, type Request, type Response, type Application } from "express";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ConductorConfig } from "../config.ts";
import type {
	ChatRequest,
	HealthResponse,
	PosseCommand,
	PosseCommandResult,
	TaskRouter,
} from "../types.ts";

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
	/** Express app instance */
	app: Application;
	/** Start the server */
	start(): Promise<void>;
	/** Stop the server */
	stop(): Promise<void>;
	/** Get server port */
	getPort(): number;
	/** Check if server is running */
	isRunning(): boolean;
}

// ============================================================================
// Request Logging Middleware
// ============================================================================

interface RequestWithTiming extends Request {
	startTime?: number;
	method: string;
	path: string;
}

function requestLogger(req: RequestWithTiming, res: Response, next: NextFunction): void {
	req.startTime = Date.now();

	res.on("finish", () => {
		const duration = Date.now() - (req.startTime || Date.now());
		const timestamp = new Date().toISOString();
		console.log(`[${timestamp}] ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
	});

	next();
}

// ============================================================================
// Error Handling Middleware
// ============================================================================

interface ErrorResponse {
	error: string;
	code: string;
	message: string;
}

function errorHandler(
	err: Error,
	_req: Request,
	res: Response<ErrorResponse>,
	_next: NextFunction,
): void {
	const timestamp = new Date().toISOString();
	console.error(`[${timestamp}] Error:`, err.message);

	// Determine status code based on error type
	let statusCode = 500;
	let errorCode = "INTERNAL_ERROR";

	if (err.message.includes("not found")) {
		statusCode = 404;
		errorCode = "NOT_FOUND";
	} else if (err.message.includes("unauthorized") || err.message.includes("unauthenticated")) {
		statusCode = 401;
		errorCode = "UNAUTHORIZED";
	} else if (err.message.includes("forbidden")) {
		statusCode = 403;
		errorCode = "FORBIDDEN";
	} else if (err.message.includes("validation") || err.message.includes("invalid")) {
		statusCode = 400;
		errorCode = "VALIDATION_ERROR";
	} else if (err.message.includes("timeout")) {
		statusCode = 504;
		errorCode = "GATEWAY_TIMEOUT";
	} else if (err.message.includes("no agents available")) {
		statusCode = 503;
		errorCode = "SERVICE_UNAVAILABLE";
	}

	res.status(statusCode).json({
		error: err.message,
		code: errorCode,
		message: err.message,
	});
}

// ============================================================================
// Authentication Middleware
// ============================================================================

function createAuthMiddleware(authToken?: string) {
	return (req: Request, res: Response, next: NextFunction): void => {
		if (!authToken) {
			next();
			return;
		}

		const header = req.headers.authorization;
		if (!header) {
			res.status(401).json({
				error: "Authorization required",
				code: "UNAUTHORIZED",
				message: "Missing Authorization header",
			});
			return;
		}

		const parts = header.split(" ");
		if (parts.length !== 2 || parts[0] !== "Bearer") {
			res.status(401).json({
				error: "Invalid authorization format",
				code: "UNAUTHORIZED",
				message: 'Expected "Bearer <token>" format',
			});
			return;
		}

		if (parts[1] !== authToken) {
			res.status(401).json({
				error: "Invalid token",
				code: "UNAUTHORIZED",
				message: "The provided token is invalid",
			});
			return;
		}

		next();
	};
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Create health check handler
 */
function createHealthHandler(
	config: ConductorConfig,
	registry?: AgentRegistry,
): (req: Request, res: Response) => Promise<void> {
	return async (_req: Request, res: Response) => {
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

		res.status(status === "healthy" ? 200 : status === "degraded" ? 200 : 503).json(response);
	};
}

/**
 * Create chat handler
 */
function createChatHandler(
	_router: TaskRouter,
	_timeout: number,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
	return async (req: Request, res: Response, next: NextFunction) => {
		try {
			const chatRequest: ChatRequest = req.body;

			// Validate request
			if (!chatRequest.messages || !Array.isArray(chatRequest.messages)) {
				res.status(400).json({
					error: "Invalid request",
					code: "VALIDATION_ERROR",
					message: "messages array is required",
				});
				return;
			}

			// TODO: Implement actual routing and task submission
			// For now, return a placeholder response
			const result: TaskResult = {
				id: crypto.randomUUID(),
				status: "completed",
				response: {
					id: crypto.randomUUID(),
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: chatRequest.model || "default",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: "Task routing not yet implemented",
							},
							finish_reason: "stop",
						},
					],
				},
				timestamp: new Date().toISOString(),
			};

			res.json(result);
		} catch (err) {
			next(err);
		}
	};
}

/**
 * Create agents list handler (posse mode only)
 */
function createAgentsHandler(
	config: ConductorConfig,
	registry?: AgentRegistry,
): (req: Request, res: Response) => void {
	return (_req: Request, res: Response) => {
		if (config.mode !== "posse") {
			res.status(403).json({
				error: "Not available in single mode",
				code: "FORBIDDEN",
				message: "Posse endpoints only available in posse mode",
			});
			return;
		}

		if (!registry) {
			res.status(503).json({
				error: "Registry not available",
				code: "SERVICE_UNAVAILABLE",
				message: "Agent registry is not initialized",
			});
			return;
		}

		const agents = registry.getAllAgents();
		res.json({
			agents,
			total: agents.length,
			timestamp: new Date().toISOString(),
		});
	};
}

/**
 * Create posse command handler
 */
function createCommandHandler(
	config: ConductorConfig,
	registry?: AgentRegistry,
): (req: Request, res: Response) => Promise<void> {
	return async (req: Request, res: Response) => {
		if (config.mode !== "posse") {
			res.status(403).json({
				error: "Not available in single mode",
				code: "FORBIDDEN",
				message: "Posse endpoints only available in posse mode",
			});
			return;
		}

		if (!registry) {
			res.status(503).json({
				error: "Registry not available",
				code: "SERVICE_UNAVAILABLE",
				message: "Agent registry is not initialized",
			});
			return;
		}

		const command: PosseCommand = req.body;
		const targetAgent = req.query.agent as string | undefined;

		// Validate command
		if (!command.command) {
			res.status(400).json({
				error: "Invalid command",
				code: "VALIDATION_ERROR",
				message: "command field is required",
			});
			return;
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

		res.json(result);
	};
}

/**
 * Create detailed health handler
 */
function createPosseHealthHandler(
	config: ConductorConfig,
	registry?: AgentRegistry,
): (req: Request, res: Response) => void {
	return (_req: Request, res: Response) => {
		if (config.mode !== "posse") {
			res.status(403).json({
				error: "Not available in single mode",
				code: "FORBIDDEN",
				message: "Posse endpoints only available in posse mode",
			});
			return;
		}

		if (!registry) {
			res.status(503).json({
				error: "Registry not available",
				code: "SERVICE_UNAVAILABLE",
				message: "Agent registry is not initialized",
			});
			return;
		}

		const agents = registry.getAllAgents();
		const stats = registry.getStats();

		res.json({
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
	};
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

	const app = express();

	// Middleware
	app.use(
		cors({
			origin: gatewayConfig.cors?.origins ?? "*",
			credentials: gatewayConfig.cors?.credentials ?? true,
		}),
	);
	app.use(express.json({ limit: "10mb" }));
	app.use(requestLogger);

	// Health endpoint BEFORE auth middleware (must be publicly accessible for healthchecks)
	app.get("/health", createHealthHandler(config, registry));

	// Authentication middleware (if configured) — applies to all routes below
	const authMiddleware = createAuthMiddleware(gatewayConfig.authToken);
	app.use(authMiddleware);

	// Routes (auth-protected)
	if (router && gatewayConfig.timeout) {
		app.post("/v1/chat", createChatHandler(router, gatewayConfig.timeout));
	}

	// Posse-only routes
	app.get("/posse/agents", createAgentsHandler(config, registry));
	app.post("/posse/command", createCommandHandler(config, registry));
	app.get("/posse/health", createPosseHealthHandler(config, registry));

	// Error handling
	app.use(errorHandler);

	// Server instance
	let server: ReturnType<typeof app.listen> | null = null;
	let isRunning = false;
	let actualPort: number = gatewayConfig.port;

	return {
		app,

		async start(): Promise<void> {
			if (isRunning) {
				console.warn("HTTP server already running");
				return;
			}

			return new Promise((resolve, reject) => {
				server = app.listen(gatewayConfig.port, gatewayConfig.host, () => {
					isRunning = true;
					// Get the actual port (in case port 0 was used)
					const addr = server?.address();
					if (addr && typeof addr === "object") {
						actualPort = addr.port;
					}
					console.log(`HTTP Gateway listening on http://${gatewayConfig.host}:${actualPort}`);
					resolve();
				});

				server.on("error", (err: Error) => {
					reject(err);
				});
			});
		},

		async stop(): Promise<void> {
			if (!isRunning || !server) {
				return;
			}

			return new Promise((resolve, reject) => {
				if (server) {
					server.close((err: Error | undefined) => {
						if (err) {
							reject(err);
						} else {
							isRunning = false;
							console.log("HTTP Gateway stopped");
							resolve();
						}
					});
				} else {
					resolve();
				}
			});
		},

		getPort(): number {
			return actualPort;
		},

		isRunning(): boolean {
			return isRunning;
		},
	};
}
