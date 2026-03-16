/**
 * Parse <route> structured tags from agent output for mesh routing.
 * R4.6: Extracts routing requests for cross-instance task delegation.
 */

import { createLogger } from "@randal/core";
import { z } from "zod";

const logger = createLogger({ context: { component: "route-parser" } });

export const routeRequestSchema = z.object({
	instance: z.string().min(1, "Instance name is required"),
	reason: z.string().optional(),
	task: z.string().min(1, "Task description is required"),
});

export type RouteRequest = z.infer<typeof routeRequestSchema>;

/**
 * Extract all <route> tags from agent output and parse them.
 * Format: <route instance="backend-agent" reason="database migration">task description</route>
 */
export function parseRouteRequests(output: string): RouteRequest[] {
	const regex = /<route\s+instance="([^"]+)"(?:\s+reason="([^"]*)")?\s*>([\s\S]*?)<\/route>/g;
	const requests: RouteRequest[] = [];

	for (const match of output.matchAll(regex)) {
		const raw = {
			instance: match[1],
			reason: match[2] || undefined,
			task: match[3]?.trim() || "",
		};

		const result = routeRequestSchema.safeParse(raw);
		if (result.success) {
			requests.push(result.data);
		} else {
			logger.warn("Invalid route request", {
				instance: raw.instance,
				errors: result.error.issues.map((i) => i.message),
			});
		}
	}

	return requests;
}
