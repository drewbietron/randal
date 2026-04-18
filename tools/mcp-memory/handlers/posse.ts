/**
 * Posse delegation tool handlers: posse_members, delegate_task, posse_memory_search.
 *
 * Handles cross-instance discovery, auto-routing, health checks, job delegation,
 * and polling for completion.
 */

import { getPrimaryDomain } from "@randal/analytics";
import { queryPosseMembers, registryDocToMeshInstance, searchCrossAgent } from "@randal/memory";
import type { RegistryClient } from "@randal/memory";
import { checkHealth, routeTask } from "@randal/mesh";
import type { RoutingContext } from "@randal/mesh";
import { MeiliSearch } from "meilisearch";
import { ToolError, log } from "../../lib/mcp-transport.js";
import type { ToolDefinition, ToolHandler } from "../../lib/mcp-transport.js";
import { buildPosseConfigStub, embeddingService, ensurePosse } from "../init.js";
import { MEILI_MASTER_KEY, MEILI_URL, RANDAL_PEER_AUTH_TOKEN, RANDAL_SELF_NAME } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POSSE_NOT_CONFIGURED =
	"Posse not configured. Set RANDAL_POSSE_NAME and RANDAL_SELF_NAME environment variables to enable posse tools.";

/** Maximum time to poll for a delegated job to complete (5 minutes). */
const DELEGATE_POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** Interval between job status polls (3 seconds). */
const DELEGATE_POLL_INTERVAL_MS = 3000;
/** HTTP request timeout for delegation calls (30 seconds). */
const DELEGATE_HTTP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "posse_members",
		description:
			"Discover other Randal instances in your posse. Returns name, status, role (broad domain), expertise (detailed skills), specialization, capabilities, endpoint, and last heartbeat for each member. Use this to see who is available before delegating work.",
		inputSchema: {
			type: "object" as const,
			properties: {},
			required: [],
		},
	},
	{
		name: "delegate_task",
		description:
			"Send a task to another Randal instance in the posse. Specify a target peer by name, or omit to auto-route to the best-fit instance. Returns the job ID and result (or polls until complete).",
		inputSchema: {
			type: "object" as const,
			properties: {
				task: {
					type: "string",
					description: "The task description to delegate",
				},
				target: {
					type: "string",
					description: "Name of the target peer (from posse_members). Omit for auto-routing.",
				},
				domain: {
					type: "string",
					description:
						"Task domain hint for auto-routing (e.g. 'product-engineering', 'security-compliance'). Auto-detected from task if omitted.",
				},
				model: {
					type: "string",
					description: "Preferred model for the task (used in auto-routing scoring)",
				},
				async: {
					type: "boolean",
					description:
						"If true, return immediately with the job ID instead of waiting for completion (default: false)",
				},
			},
			required: ["task"],
		},
	},
	{
		name: "posse_memory_search",
		description:
			"Search shared posse memory across other Randal instances. Returns learnings, patterns, and facts from peers. Useful for checking if another instance already solved a similar problem.",
		inputSchema: {
			type: "object" as const,
			properties: {
				query: {
					type: "string",
					description: "Search query for cross-agent memory",
				},
				limit: {
					type: "number",
					description: "Maximum number of results to return (default 5)",
				},
			},
			required: ["query"],
		},
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a MeiliSearch client cast as RegistryClient for posse queries. */
function createPosseClient(): RegistryClient {
	return new MeiliSearch({
		host: MEILI_URL,
		apiKey: MEILI_MASTER_KEY || undefined,
	}) as unknown as RegistryClient;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePosseMembers(_params: Record<string, unknown>): Promise<unknown> {
	if (!ensurePosse()) {
		return { members: [], message: POSSE_NOT_CONFIGURED };
	}

	try {
		const config = buildPosseConfigStub();
		const posseClient = createPosseClient();
		const docs = await queryPosseMembers(config, posseClient);

		return {
			members: docs.map((doc) => ({
				name: doc.name,
				status: doc.status,
				role: doc.role,
				expertise: doc.expertise
					? doc.expertise.length > 200
						? `${doc.expertise.slice(0, 200)}...`
						: doc.expertise
					: undefined,
				capabilities: doc.capabilities,
				endpoint: doc.endpoint,
				lastHeartbeat: doc.lastHeartbeat,
				isSelf: doc.name === RANDAL_SELF_NAME,
			})),
		};
	} catch (err) {
		log("error", `posse_members failed: ${err instanceof Error ? err.message : String(err)}`);
		return { members: [], message: "Failed to query posse members" };
	}
}

async function handleDelegateTask(params: Record<string, unknown>): Promise<unknown> {
	const task = params.task as string;
	if (!task) {
		throw new ToolError("Missing required parameter: task");
	}

	if (!ensurePosse()) {
		return { delegated: false, message: POSSE_NOT_CONFIGURED };
	}

	const target = params.target as string | undefined;
	const domain = params.domain as string | undefined;
	const model = params.model as string | undefined;
	const isAsync = params.async === true;

	// Guard: reject self-delegation
	if (target && target === RANDAL_SELF_NAME) {
		return { delegated: false, message: "Cannot delegate to self" };
	}

	try {
		const config = buildPosseConfigStub();
		const posseClient = createPosseClient();
		const docs = await queryPosseMembers(config, posseClient);

		// Filter out self
		const peers = docs.filter((d) => d.name !== RANDAL_SELF_NAME);
		if (peers.length === 0) {
			return { delegated: false, message: "No peers available in the posse" };
		}

		let targetEndpoint: string | undefined;
		let targetName: string | undefined;

		if (target) {
			// Explicit target — find by name
			const peer = peers.find((d) => d.name === target);
			if (!peer) {
				return {
					delegated: false,
					message: `Peer "${target}" not found in posse. Available: ${peers.map((p) => p.name).join(", ")}`,
				};
			}
			if (!peer.endpoint) {
				return {
					delegated: false,
					message: `Peer "${target}" has no endpoint registered`,
				};
			}
			targetEndpoint = peer.endpoint;
			targetName = peer.name;
		} else {
			// Auto-detect domain from task if not explicitly provided (R4)
			const effectiveDomain = domain || getPrimaryDomain(task);

			// Embed task for semantic routing (non-fatal — falls back to role/specialization matching)
			const taskVector = embeddingService
				? await embeddingService.embed(task).catch(() => null)
				: null;

			// Auto-route using mesh router
			const instances = peers.map(registryDocToMeshInstance);

			// Pre-filter by role if domain was auto-detected and there are enough candidates
			let candidates = instances;
			if (effectiveDomain && effectiveDomain !== "general" && instances.length > 2) {
				const roleFiltered = instances.filter((i) => i.role === effectiveDomain);
				if (roleFiltered.length > 0) {
					candidates = roleFiltered;
				}
				// If no role matches, keep all candidates — let the router score by other factors
			}

			log(
				"info",
				`Routing context: domain=${effectiveDomain}, taskVector=${!!taskVector}, candidates=${candidates.length}/${instances.length}`,
			);

			const routingContext: RoutingContext = {
				prompt: task,
				domain: effectiveDomain,
				model,
				taskVector: taskVector ?? undefined,
			};
			const decision = routeTask(candidates, routingContext);
			if (!decision) {
				return {
					delegated: false,
					message: "No suitable peer found for auto-routing. Consider specifying a target.",
				};
			}
			if (!decision.instance.endpoint) {
				return {
					delegated: false,
					message: `Best peer "${decision.instance.name}" has no endpoint registered`,
				};
			}
			targetEndpoint = decision.instance.endpoint;
			targetName = decision.instance.name;
			log(
				"info",
				`Auto-routed to ${targetName} (score: ${decision.score.toFixed(2)}, reason: ${decision.reason})`,
			);
		}

		// Pre-flight health check
		const healthResult = await checkHealth({
			instanceId: targetName,
			name: targetName,
			endpoint: targetEndpoint,
			status: "idle",
			capabilities: [],
			lastHeartbeat: new Date().toISOString(),
			models: [],
			activeJobs: 0,
			completedJobs: 0,
			health: { uptime: 0, missedPings: 0 },
		});

		if (!healthResult.healthy) {
			return {
				delegated: false,
				message: `Peer "${targetName}" is not healthy: ${healthResult.error ?? "unknown error"}`,
			};
		}

		// POST to peer's /job endpoint
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (RANDAL_PEER_AUTH_TOKEN) {
			headers.Authorization = `Bearer ${RANDAL_PEER_AUTH_TOKEN}`;
		}

		const jobResp = await fetch(`${targetEndpoint}/job`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				prompt: task,
				origin: {
					channel: "posse",
					from: RANDAL_SELF_NAME,
				},
			}),
			signal: AbortSignal.timeout(DELEGATE_HTTP_TIMEOUT_MS),
		});

		if (!jobResp.ok) {
			const body = await jobResp.text().catch(() => "");
			return {
				delegated: false,
				message: `Peer "${targetName}" rejected the job: HTTP ${jobResp.status} ${body}`,
			};
		}

		const jobData = (await jobResp.json()) as { id?: string; jobId?: string };
		const jobId = jobData.id ?? jobData.jobId;
		if (!jobId) {
			return {
				delegated: false,
				message: `Peer "${targetName}" returned no job ID`,
			};
		}

		log("info", `Task delegated to ${targetName}: jobId=${jobId}`);

		// If async, return immediately
		if (isAsync) {
			return {
				delegated: true,
				jobId,
				target: targetName,
				status: "submitted",
				message: `Task submitted to ${targetName}. Check status at ${targetEndpoint}/job/${jobId}`,
			};
		}

		// Poll for completion
		const deadline = Date.now() + DELEGATE_POLL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, DELEGATE_POLL_INTERVAL_MS));

			try {
				const statusResp = await fetch(`${targetEndpoint}/job/${jobId}`, {
					headers,
					signal: AbortSignal.timeout(DELEGATE_HTTP_TIMEOUT_MS),
				});

				if (!statusResp.ok) continue;

				const statusData = (await statusResp.json()) as {
					status?: string;
					summary?: string;
					error?: string;
					filesChanged?: string[];
				};

				if (
					statusData.status === "completed" ||
					statusData.status === "failed" ||
					statusData.status === "stopped"
				) {
					return {
						delegated: true,
						jobId,
						target: targetName,
						status: statusData.status,
						summary: statusData.summary ?? "",
						error: statusData.error,
						filesChanged: statusData.filesChanged ?? [],
					};
				}
			} catch {
				// Poll failure — retry
			}
		}

		return {
			delegated: true,
			jobId,
			target: targetName,
			status: "timeout",
			message: `Job ${jobId} on ${targetName} did not complete within ${DELEGATE_POLL_TIMEOUT_MS / 1000}s. Check status manually.`,
		};
	} catch (err) {
		log("error", `delegate_task failed: ${err instanceof Error ? err.message : String(err)}`);
		return {
			delegated: false,
			message: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

async function handlePosseMemorySearch(params: Record<string, unknown>): Promise<unknown> {
	const query = params.query as string;
	if (!query) {
		throw new ToolError("Missing required parameter: query");
	}

	if (!ensurePosse()) {
		return { results: [], message: POSSE_NOT_CONFIGURED };
	}

	const config = buildPosseConfigStub();
	const readFrom = config.memory.sharing.readFrom;
	if (readFrom.length === 0) {
		return {
			results: [],
			message:
				"No cross-agent indexes configured. Set RANDAL_CROSS_AGENT_READ_FROM (comma-separated index names).",
		};
	}

	const limit = typeof params.limit === "number" ? params.limit : 5;

	try {
		const docs = await searchCrossAgent(query, config, limit);

		return {
			results: docs.map((doc) => ({
				id: doc.id,
				type: doc.type,
				category: doc.category,
				content: doc.content,
				source: doc.source,
				scope: doc.scope,
				timestamp: doc.timestamp,
			})),
		};
	} catch (err) {
		log("error", `posse_memory_search failed: ${err instanceof Error ? err.message : String(err)}`);
		return { results: [], message: "Cross-agent memory search failed" };
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, ToolHandler> = {
	posse_members: handlePosseMembers,
	delegate_task: handleDelegateTask,
	posse_memory_search: handlePosseMemorySearch,
};

/**
 * Register posse delegation tool definitions and handlers.
 * Returns { definitions, handlers } for the entrypoint to merge.
 */
export function registerPosseHandlers() {
	return { definitions: TOOL_DEFINITIONS, handlers: HANDLERS };
}
