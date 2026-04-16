/**
 * Task Router for Posse Conductor
 *
 * Routes tasks to appropriate agents based on strategy:
 * - Single mode: Direct proxy to configured agent
 * - Posse mode: Auto, round-robin, or explicit selection
 * - Multi-agent support for parallel task execution
 */

import type { AgentRegistry, EnrichedAgentRecord } from "../agents/registry.ts";
import type { ConductorConfig } from "../config.ts";
import type { AgentRecord } from "../types.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Task definition
 */
export interface Task {
	/** Unique task identifier */
	id: string;
	/** Task content/instruction */
	content: string;
	/** Channel this task came from */
	channel: string;
	/** User identifier */
	userId: string;
	/** Task creation timestamp */
	timestamp: string;
	/** Explicitly specified agent (optional) */
	explicitAgent?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Task routing result
 */
export interface TaskResult {
	/** Task ID */
	taskId: string;
	/** Response content */
	content: string;
	/** Agent that handled the task */
	agent: string;
	/** Whether the task succeeded */
	success: boolean;
	/** Duration in ms */
	duration: number;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Task analysis for intelligent routing
 */
export interface TaskIntent {
	/** Detected task type */
	type: string;
	/** Estimated complexity (1-10) */
	complexity: number;
	/** Suggested agent names */
	suggestedAgents: string[];
	/** Required capabilities */
	capabilities?: string[];
}

/**
 * Routing strategy
 */
export type RoutingStrategy = "auto" | "round-robin" | "explicit";

/**
 * Agent client for sending tasks via HTTP
 */
export interface AgentClient {
	/**
	 * Send a task to an agent
	 */
	sendTask(endpoint: string, task: Task): Promise<AgentResponse>;
}

/**
 * Agent response format
 */
export interface AgentResponse {
	/** Whether the request succeeded */
	success: boolean;
	/** Response content */
	content?: string;
	/** Error message if failed */
	error?: string;
	/** Response metadata */
	metadata?: Record<string, unknown>;
}

// ============================================================================
// Errors
// ============================================================================

export class RoutingError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly statusCode: number = 500,
	) {
		super(message);
		this.name = "RoutingError";
	}
}

export class NoHealthyAgentsError extends RoutingError {
	constructor() {
		super("No healthy agents available", "NO_HEALTHY_AGENTS", 503);
	}
}

export class AgentNotFoundError extends RoutingError {
	constructor(agentName: string) {
		super(`Agent not found: ${agentName}`, "AGENT_NOT_FOUND", 404);
	}
}

export class TaskTimeoutError extends RoutingError {
	constructor(taskId: string, duration: number) {
		super(`Task ${taskId} timed out after ${duration}ms`, "TASK_TIMEOUT", 504);
	}
}

// ============================================================================
// HTTP Agent Client
// ============================================================================

export interface HttpAgentClientOptions {
	/** Request timeout in ms */
	timeout?: number;
	/** Max retries for failed requests */
	maxRetries?: number;
}

export class HttpAgentClient implements AgentClient {
	private timeout: number;
	private maxRetries: number;

	constructor(options: HttpAgentClientOptions = {}) {
		this.timeout = options.timeout ?? 120000;
		this.maxRetries = options.maxRetries ?? 3;
	}

	async sendTask(endpoint: string, task: Task): Promise<AgentResponse> {
		const startTime = Date.now();
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);

				const response = await fetch(`${endpoint}/v1/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: "default",
						messages: [{ role: "user", content: task.content }],
					}),
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					throw new Error(`Agent returned ${response.status}: ${await response.text()}`);
				}

				const data = await response.json();
				const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data);

				return {
					success: true,
					content,
					metadata: {
						duration: Date.now() - startTime,
						attempts: attempt,
					},
				};
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				if (attempt < this.maxRetries) {
					// Exponential backoff
					await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
				}
			}
		}

		return {
			success: false,
			error: lastError?.message ?? "Unknown error",
			metadata: {
				duration: Date.now() - startTime,
				attempts: this.maxRetries,
			},
		};
	}
}

// ============================================================================
// Task Router
// ============================================================================

export class TaskRouter {
	private config: ConductorConfig;
	private registry: AgentRegistry | undefined;
	private agentClient: AgentClient;
	private roundRobinIndex = 0;

	constructor(config: ConductorConfig, registry?: AgentRegistry, agentClient?: AgentClient) {
		this.config = config;
		this.registry = registry;
		this.agentClient =
			agentClient ??
			new HttpAgentClient({
				timeout: 120000,
				maxRetries: 3,
			});
	}

	/**
	 * Route a task to an appropriate agent
	 */
	async routeTask(task: Task): Promise<TaskResult> {
		const startTime = Date.now();
		const strategy = this.config.routing.strategy;

		try {
			if (this.config.mode === "single") {
				return await this.routeSingleMode(task, startTime);
			}

			// Posse mode
			if (!this.registry) {
				throw new RoutingError("Registry required in posse mode", "NO_REGISTRY", 500);
			}

			switch (strategy) {
				case "explicit":
					return await this.routeExplicit(task, startTime);
				case "round-robin":
					return await this.routeRoundRobin(task, startTime);
				default:
					return await this.routeAuto(task, startTime);
			}
		} catch (err) {
			const duration = Date.now() - startTime;

			if (err instanceof RoutingError) {
				throw err;
			}

			return {
				taskId: task.id,
				content: "",
				agent: "unknown",
				success: false,
				duration,
				metadata: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	}

	/**
	 * Route task to multiple agents in parallel
	 */
	async routeToMultiple(task: Task, agentNames: string[]): Promise<TaskResult[]> {
		const results = await Promise.all(
			agentNames.map(async (agentName) => {
				const agent = this.registry?.getAgent(agentName);
				if (!agent) {
					return {
						taskId: task.id,
						content: "",
						agent: agentName,
						success: false,
						duration: 0,
						metadata: { error: "Agent not found" },
					};
				}
				return this.sendToAgent(task, agent);
			}),
		);

		return results;
	}

	// ============================================================================
	// Private Routing Methods
	// ============================================================================

	/**
	 * Single mode: Direct proxy to configured agent
	 */
	private async routeSingleMode(task: Task, startTime: number): Promise<TaskResult> {
		const agent = this.config.agent;
		if (!agent) {
			throw new RoutingError("No agent configured for single mode", "NO_AGENT_CONFIG", 500);
		}

		try {
			const response = await this.agentClient.sendTask(agent.url, task);
			const duration = Date.now() - startTime;

			return {
				taskId: task.id,
				content: response.content ?? "",
				agent: agent.name,
				success: response.success,
				duration,
				metadata: response.metadata,
			};
		} catch (err) {
			const duration = Date.now() - startTime;
			return {
				taskId: task.id,
				content: "",
				agent: agent.name,
				success: false,
				duration,
				metadata: {
					error: err instanceof Error ? err.message : String(err),
				},
			};
		}
	}

	/**
	 * Explicit routing: Use task.explicitAgent
	 */
	private async routeExplicit(task: Task, startTime: number): Promise<TaskResult> {
		const agentName = task.explicitAgent;
		if (!agentName) {
			throw new RoutingError("No explicit agent specified", "NO_EXPLICIT_AGENT", 400);
		}

		const agent = this.registry?.getAgent(agentName);
		if (!agent) {
			throw new AgentNotFoundError(agentName);
		}

		if (!agent.health.isResponsive) {
			throw new RoutingError(`Agent ${agentName} is not responsive`, "AGENT_UNRESPONSIVE", 503);
		}

		return this.sendToAgent(task, agent, startTime);
	}

	/**
	 * Round-robin routing: Cycle through healthy agents
	 */
	private async routeRoundRobin(task: Task, startTime: number): Promise<TaskResult> {
		const agents = this.registry?.getHealthyAgents() ?? [];
		if (agents.length === 0) {
			throw new NoHealthyAgentsError();
		}

		// Get next agent in round-robin
		const agent = agents[this.roundRobinIndex % agents.length];
		this.roundRobinIndex = (this.roundRobinIndex + 1) % agents.length;

		return this.sendToAgent(task, agent, startTime);
	}

	/**
	 * Auto routing: Use LLM to analyze and select best agent
	 */
	private async routeAuto(task: Task, startTime: number): Promise<TaskResult> {
		const agents = this.registry?.getHealthyAgents() ?? [];
		if (agents.length === 0) {
			throw new NoHealthyAgentsError();
		}

		// If only one agent, use it
		if (agents.length === 1) {
			return this.sendToAgent(task, agents[0], startTime);
		}

		// Analyze task to determine best agent
		const intent = this.analyzeTask(task, agents);

		// Try suggested agents in order
		for (const agentName of intent.suggestedAgents) {
			const agent = agents.find((a) => a.name === agentName);
			if (agent?.health.isResponsive) {
				return this.sendToAgent(task, agent, startTime);
			}
		}

		// Fallback: use any available healthy agent
		const fallbackAgent = agents.find((a) => a.health.isResponsive);
		if (!fallbackAgent) {
			throw new NoHealthyAgentsError();
		}

		return this.sendToAgent(task, fallbackAgent, startTime);
	}

	/**
	 * Send task to a specific agent
	 */
	private async sendToAgent(
		task: Task,
		agent: AgentRecord,
		startTime = Date.now(),
	): Promise<TaskResult> {
		const response = await this.agentClient.sendTask(agent.endpoint, task);
		const duration = Date.now() - startTime;

		return {
			taskId: task.id,
			content: response.content ?? "",
			agent: agent.name,
			success: response.success,
			duration,
			metadata: response.metadata,
		};
	}

	/**
	 * Analyze task to determine routing intent
	 * Simple rule-based analysis (can be enhanced with LLM)
	 */
	private analyzeTask(task: Task, availableAgents: EnrichedAgentRecord[]): TaskIntent {
		const content = task.content.toLowerCase();
		const capabilities: string[] = [];
		let complexity = 5;

		// Simple keyword matching for capabilities
		if (content.includes("code") || content.includes("program") || content.includes("function")) {
			capabilities.push("code");
		}
		if (content.includes("test") || content.includes("spec")) {
			capabilities.push("testing");
		}
		if (content.includes("deploy") || content.includes("infrastructure")) {
			capabilities.push("infra");
		}
		if (content.includes("security") || content.includes("vulnerability")) {
			capabilities.push("security");
		}
		if (content.includes("design") || content.includes("ui") || content.includes("css")) {
			capabilities.push("frontend");
		}

		// Complexity estimation
		if (content.includes("simple") || content.includes("quick")) {
			complexity = 2;
		} else if (content.includes("complex") || content.includes("architect")) {
			complexity = 8;
		}

		// Match agents by capabilities
		const suggestedAgents = availableAgents
			.filter(
				(agent) =>
					capabilities.length === 0 || capabilities.some((cap) => agent.capabilities.includes(cap)),
			)
			.map((agent) => agent.name);

		// If no specific match, include all healthy agents
		if (suggestedAgents.length === 0) {
			suggestedAgents.push(...availableAgents.map((a) => a.name));
		}

		return {
			type: capabilities[0] ?? "general",
			complexity,
			suggestedAgents,
			capabilities,
		};
	}

	// ============================================================================
	// Getters
	// ============================================================================

	/**
	 * Get current routing strategy
	 */
	getStrategy(): RoutingStrategy {
		return this.config.routing.strategy;
	}

	/**
	 * Get available healthy agents
	 */
	getHealthyAgents(): EnrichedAgentRecord[] {
		return this.registry?.getHealthyAgents() ?? [];
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new TaskRouter instance
 */
export function createTaskRouter(
	config: ConductorConfig,
	registry?: AgentRegistry,
	agentClient?: AgentClient,
): TaskRouter {
	return new TaskRouter(config, registry, agentClient);
}

/**
 * Create an HTTP agent client
 */
export function createHttpAgentClient(options?: HttpAgentClientOptions): HttpAgentClient {
	return new HttpAgentClient(options);
}
