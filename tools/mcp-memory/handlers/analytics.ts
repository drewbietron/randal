/**
 * Analytics tool handlers: reliability_scores, recommendations, get_feedback, annotate.
 *
 * Wraps the @randal/analytics package with lazy init via ensure guards.
 */

import { randomUUID } from "node:crypto";
import {
	computeReliabilityScores,
	computeTrends,
	generateFeedback,
	generateRecommendations,
	getPrimaryDomain,
} from "@randal/analytics";
import type { Annotation, AnnotationVerdict } from "@randal/core";
import { ToolError, log } from "../../lib/mcp-transport.js";
import type { ToolDefinition, ToolHandler } from "../../lib/mcp-transport.js";
import { annotationStore, ensureAnalytics, getAnalyticsError } from "../init.js";
import { ANALYTICS_ENABLED, MEILI_HINT } from "../types.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "reliability_scores",
		description:
			"Query the brain's own pass rates across dimensions (overall, agent, model, domain, complexity). Returns scores + 7-day/30-day trends. Use this to understand your reliability before starting work.",
		inputSchema: {
			type: "object" as const,
			properties: {
				dimension: {
					type: "string",
					description:
						'Optional dimension filter: "overall", "agent", "model", "domain", or "complexity". Returns all dimensions if omitted.',
				},
				agingHalfLife: {
					type: "number",
					description:
						"Half-life for annotation aging in days (default: 30). Recent annotations weigh more.",
				},
			},
			required: [],
		},
	},
	{
		name: "recommendations",
		description:
			'Ask "what should I improve?" Returns actionable recommendations: model switches, knowledge gaps, instance splitting, trend alerts.',
		inputSchema: {
			type: "object" as const,
			properties: {},
			required: [],
		},
	},
	{
		name: "get_feedback",
		description:
			"Get empirical guidance text for a given task domain based on past annotation patterns. Returns a markdown block suitable for injection into build context.",
		inputSchema: {
			type: "object" as const,
			properties: {
				domain: {
					type: "string",
					description:
						'Task domain to get feedback for (e.g., "frontend", "backend", "database", "infra", "docs", "testing").',
				},
			},
			required: ["domain"],
		},
	},
	{
		name: "annotate",
		description:
			"Submit a quality annotation for a completed task. Used to track agent reliability and feed the self-learning analytics loop.",
		inputSchema: {
			type: "object" as const,
			properties: {
				jobId: {
					type: "string",
					description: "Job ID or plan slug to annotate",
				},
				verdict: {
					type: "string",
					description: 'Annotation verdict: "pass", "fail", or "partial"',
				},
				feedback: {
					type: "string",
					description: "Optional feedback text describing what went well or wrong",
				},
				categories: {
					type: "array",
					items: { type: "string" },
					description: "Optional category tags for the annotation",
				},
				agent: {
					type: "string",
					description: 'Agent name (default: "opencode")',
				},
				model: {
					type: "string",
					description: 'Model used (default: "unknown")',
				},
				prompt: {
					type: "string",
					description: "Original task prompt (used for domain auto-detection)",
				},
				domain: {
					type: "string",
					description: "Task domain. Auto-detected from prompt if omitted.",
				},
				iterationCount: {
					type: "number",
					description: "Number of iterations/attempts (default: 1)",
				},
				tokenCost: {
					type: "number",
					description: "Estimated token cost (default: 0)",
				},
				duration: {
					type: "number",
					description: "Wall time in seconds (default: 0)",
				},
				filesChanged: {
					type: "array",
					items: { type: "string" },
					description: "List of files changed during the task",
				},
			},
			required: ["jobId", "verdict"],
		},
	},
];

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Fetch annotations and compute scores to avoid redundant work. */
async function getAnnotationsAndScores(agingHalfLife?: number) {
	const annotations = await annotationStore.list();
	const { scores, insufficientData } = computeReliabilityScores(annotations, {
		agingHalfLife,
	});
	return { annotations, scores, insufficientData };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleReliabilityScores(params: Record<string, unknown>): Promise<unknown> {
	if (!ANALYTICS_ENABLED) {
		return {
			message: "Analytics not enabled",
			scores: [],
			trends: { sevenDay: null, thirtyDay: null },
			insufficientData: true,
		};
	}
	if (!(await ensureAnalytics())) {
		const error = getAnalyticsError();
		return {
			scores: [],
			trends: { sevenDay: null, thirtyDay: null },
			insufficientData: true,
			message: error,
			error,
			hint: MEILI_HINT,
		};
	}

	try {
		const dimension = params.dimension as string | undefined;
		const agingHalfLife =
			typeof params.agingHalfLife === "number" ? params.agingHalfLife : undefined;

		const { annotations, scores, insufficientData } = await getAnnotationsAndScores(agingHalfLife);
		const trends = computeTrends(annotations);

		const filteredScores = dimension ? scores.filter((s) => s.dimension === dimension) : scores;

		return {
			scores: filteredScores,
			trends,
			insufficientData,
			totalAnnotations: annotations.length,
		};
	} catch (err) {
		log("error", `reliability_scores failed: ${err instanceof Error ? err.message : String(err)}`);
		return {
			scores: [],
			trends: { sevenDay: null, thirtyDay: null },
			insufficientData: true,
			message: "Failed to compute scores",
		};
	}
}

async function handleRecommendations(_params: Record<string, unknown>): Promise<unknown> {
	if (!ANALYTICS_ENABLED) {
		return { message: "Analytics not enabled", recommendations: [] };
	}
	if (!(await ensureAnalytics())) {
		const error = getAnalyticsError();
		return { recommendations: [], message: error, error, hint: MEILI_HINT };
	}

	try {
		const { annotations, scores } = await getAnnotationsAndScores();
		const recommendations = generateRecommendations(scores, annotations);

		return { recommendations };
	} catch (err) {
		log("error", `recommendations failed: ${err instanceof Error ? err.message : String(err)}`);
		return { recommendations: [], message: "Failed to generate recommendations" };
	}
}

async function handleGetFeedback(params: Record<string, unknown>): Promise<unknown> {
	const domain = params.domain as string;
	if (!domain) {
		throw new ToolError("Missing required parameter: domain");
	}

	if (!ANALYTICS_ENABLED) {
		return { message: "Analytics not enabled", feedback: "", domain };
	}
	if (!(await ensureAnalytics())) {
		const error = getAnalyticsError();
		return { feedback: "", domain, message: error, error, hint: MEILI_HINT };
	}

	try {
		const { annotations, scores } = await getAnnotationsAndScores();
		const feedback = generateFeedback(scores, annotations, domain);

		return { feedback, domain };
	} catch (err) {
		log("error", `get_feedback failed: ${err instanceof Error ? err.message : String(err)}`);
		return { feedback: "", domain, message: "Failed to generate feedback" };
	}
}

async function handleAnnotate(params: Record<string, unknown>): Promise<unknown> {
	const jobId = params.jobId as string;
	const verdict = params.verdict as string;

	if (!jobId) {
		throw new ToolError("Missing required parameter: jobId");
	}
	if (!verdict || !["pass", "fail", "partial"].includes(verdict)) {
		throw new ToolError(
			'Missing or invalid parameter: verdict (must be "pass", "fail", or "partial")',
		);
	}

	if (!ANALYTICS_ENABLED) {
		return { success: false, message: "Analytics not enabled" };
	}
	if (!(await ensureAnalytics())) {
		const error = getAnalyticsError();
		return { success: false, message: error, error, hint: MEILI_HINT };
	}

	try {
		const prompt = (params.prompt as string) || "";
		const domain = (params.domain as string) || (prompt ? getPrimaryDomain(prompt) : "general");

		const annotation: Annotation = {
			id: randomUUID(),
			jobId,
			verdict: verdict as AnnotationVerdict,
			feedback: (params.feedback as string) || undefined,
			categories: (params.categories as string[]) || undefined,
			agent: (params.agent as string) || "opencode",
			model: (params.model as string) || "unknown",
			domain,
			iterationCount: typeof params.iterationCount === "number" ? params.iterationCount : 1,
			tokenCost: typeof params.tokenCost === "number" ? params.tokenCost : 0,
			duration: typeof params.duration === "number" ? params.duration : 0,
			filesChanged: (params.filesChanged as string[]) || [],
			prompt,
			timestamp: new Date().toISOString(),
		};

		await annotationStore.save(annotation);

		return {
			success: true,
			annotationId: annotation.id,
			domain,
			message: "Annotation saved successfully",
		};
	} catch (err) {
		log("error", `annotate failed: ${err instanceof Error ? err.message : String(err)}`);
		return { success: false, message: "Failed to save annotation" };
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, ToolHandler> = {
	reliability_scores: handleReliabilityScores,
	recommendations: handleRecommendations,
	get_feedback: handleGetFeedback,
	annotate: handleAnnotate,
};

/**
 * Register analytics tool definitions and handlers.
 * Returns { definitions, handlers } for the entrypoint to merge.
 */
export function registerAnalyticsHandlers() {
	return { definitions: TOOL_DEFINITIONS, handlers: HANDLERS };
}
