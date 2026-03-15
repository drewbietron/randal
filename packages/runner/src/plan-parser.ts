import type { DelegationRequest, JobPlanTask } from "@randal/core";
import { createLogger } from "@randal/core";
import { z } from "zod";

const logger = createLogger({ context: { component: "plan-parser" } });

// ---- Zod schemas ----

const planTaskSchema = z.object({
	task: z.string().min(1),
	status: z.enum(["pending", "in_progress", "completed", "failed"]),
});

const delegationRequestSchema = z.object({
	task: z.string().min(1),
	context: z.string().optional(),
	agent: z.string().optional(),
	model: z.string().optional(),
	maxIterations: z.number().positive().optional(),
});

// ---- Tag extraction helpers ----

/**
 * Extract all content blocks between matching open/close tags.
 * Returns array of trimmed content strings.
 */
function extractTagBlocks(output: string, tagName: string): string[] {
	const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "g");
	const blocks: string[] = [];
	for (const match of output.matchAll(regex)) {
		blocks.push(match[1].trim());
	}
	return blocks;
}

// ---- Parsers ----

/**
 * Parse plan-update tags from agent output.
 * Extracts the last <plan-update>...</plan-update> block, parses as JSON,
 * and validates each entry with Zod.
 *
 * Returns null on any failure (logged as warning).
 * If multiple <plan-update> blocks exist, uses the last one.
 */
export function parsePlanUpdate(output: string): JobPlanTask[] | null {
	const blocks = extractTagBlocks(output, "plan-update");
	if (blocks.length === 0) return null;

	// Use last block
	const raw = blocks[blocks.length - 1];

	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			logger.warn("plan-update content is not an array");
			return null;
		}

		const tasks: JobPlanTask[] = [];
		for (const item of parsed) {
			const result = planTaskSchema.safeParse(item);
			if (result.success) {
				tasks.push({
					task: result.data.task,
					status: result.data.status,
				});
			} else {
				logger.warn("Invalid plan task entry", {
					item,
					errors: result.error.issues.map((i) => i.message),
				});
			}
		}

		if (tasks.length === 0) {
			logger.warn("plan-update contained no valid tasks");
			return null;
		}

		return tasks;
	} catch (err) {
		logger.warn("Failed to parse plan-update JSON", {
			error: err instanceof Error ? err.message : String(err),
			raw: raw.slice(0, 200),
		});
		return null;
	}
}

/**
 * Parse progress tags from agent output.
 * Extracts the last <progress>...</progress> block.
 *
 * Returns trimmed text or null.
 * Multiple blocks: last one wins.
 */
export function parseProgress(output: string): string | null {
	const blocks = extractTagBlocks(output, "progress");
	if (blocks.length === 0) return null;

	const text = blocks[blocks.length - 1];
	return text || null;
}

/**
 * Parse delegation request tags from agent output.
 * Extracts all <delegate>...</delegate> blocks, validates each with Zod.
 *
 * Returns array (may be empty). Invalid blocks are logged and skipped.
 */
export function parseDelegationRequests(output: string): DelegationRequest[] {
	const blocks = extractTagBlocks(output, "delegate");
	if (blocks.length === 0) return [];

	const requests: DelegationRequest[] = [];
	for (const raw of blocks) {
		try {
			const parsed = JSON.parse(raw);
			const result = delegationRequestSchema.safeParse(parsed);
			if (result.success) {
				requests.push(result.data);
			} else {
				logger.warn("Invalid delegation request", {
					errors: result.error.issues.map((i) => i.message),
					raw: raw.slice(0, 200),
				});
			}
		} catch (err) {
			logger.warn("Failed to parse delegate JSON", {
				error: err instanceof Error ? err.message : String(err),
				raw: raw.slice(0, 200),
			});
		}
	}

	return requests;
}
