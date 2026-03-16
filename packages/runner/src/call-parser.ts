/**
 * Parse <call> structured tags from agent output for outbound phone calls.
 * R2.12: Extracts outbound call requests with Zod-validated schema.
 */

import { createLogger } from "@randal/core";
import { z } from "zod";

const logger = createLogger({ context: { component: "call-parser" } });

// Phone number validation: E.164 format or common formats
const phoneRegex = /^\+?[\d\s\-().]{7,20}$/;

export const callRequestSchema = z.object({
	to: z.string().regex(phoneRegex, "Invalid phone number format"),
	reason: z.string().optional(),
	script: z.string().optional(),
	maxDuration: z.number().positive().optional(),
});

export type CallRequest = z.infer<typeof callRequestSchema>;

/**
 * Extract all <call> tags from agent output and parse them.
 * Returns array of validated call requests.
 */
export function parseCallRequests(output: string): CallRequest[] {
	const regex =
		/<call\s+to="([^"]+)"(?:\s+reason="([^"]*)")?(?:\s+maxDuration="(\d+)")?\s*>([\s\S]*?)<\/call>/g;
	const requests: CallRequest[] = [];

	for (const match of output.matchAll(regex)) {
		const raw = {
			to: match[1],
			reason: match[2] || undefined,
			script: match[4]?.trim() || undefined,
			maxDuration: match[3] ? Number.parseInt(match[3], 10) : undefined,
		};

		const result = callRequestSchema.safeParse(raw);
		if (result.success) {
			requests.push(result.data);
		} else {
			logger.warn("Invalid call request", {
				to: raw.to,
				errors: result.error.issues.map((i) => i.message),
			});
		}
	}

	// Also support self-closing <call to="..." /> format (no script)
	const selfClosingRegex =
		/<call\s+to="([^"]+)"(?:\s+reason="([^"]*)")?(?:\s+maxDuration="(\d+)")?\s*\/>/g;
	for (const match of output.matchAll(selfClosingRegex)) {
		const raw = {
			to: match[1],
			reason: match[2] || undefined,
			maxDuration: match[3] ? Number.parseInt(match[3], 10) : undefined,
		};

		const result = callRequestSchema.safeParse(raw);
		if (result.success) {
			requests.push(result.data);
		} else {
			logger.warn("Invalid self-closing call request", {
				to: raw.to,
				errors: result.error.issues.map((i) => i.message),
			});
		}
	}

	return requests;
}
