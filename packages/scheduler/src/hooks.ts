import { timingSafeEqual } from "node:crypto";
import { createLogger } from "@randal/core";
import type { RunnerEvent } from "@randal/core";
import type { Runner } from "@randal/runner";
import { Hono } from "hono";
import type { Heartbeat } from "./heartbeat.js";

// ---- Types ----

export type HookEventHandler = (event: RunnerEvent) => void;

export interface CreateHooksRouterOptions {
	token?: string;
	heartbeat: Heartbeat;
	runner: Runner;
	onEvent?: HookEventHandler;
}

// ---- Hooks router ----

const logger = createLogger({ context: { component: "hooks" } });

export function createHooksRouter(opts: CreateHooksRouterOptions): Hono {
	const { token, heartbeat, runner, onEvent } = opts;
	const app = new Hono();

	// Auth middleware
	app.use("*", async (c, next) => {
		if (!token) {
			return c.json({ error: "Hooks are not configured (no token set)" }, 403);
		}

		const authHeader = c.req.header("Authorization");
		const headerToken = authHeader?.replace("Bearer ", "") ?? c.req.header("x-randal-token");

		if (!tokensMatch(headerToken, token)) {
			return c.json({ error: "Invalid hook token" }, 401);
		}

		await next();
	});

	// Wake endpoint
	app.post("/wake", async (c) => {
		const body = await c.req.json<{
			text: string;
			mode: "now" | "next-heartbeat";
		}>();

		if (!body.text) {
			return c.json({ error: "text is required" }, 400);
		}

		const mode = body.mode ?? "next-heartbeat";

		emitEvent(onEvent, "hook.received", {
			hookSource: "wake",
			wakeMode: mode,
		});

		logger.info("Hook received: wake", { mode, text: body.text.slice(0, 100) });

		if (mode === "now") {
			// Trigger immediate heartbeat with the text as context
			await heartbeat.triggerNow(body.text);
		} else {
			// Queue for next heartbeat
			heartbeat.queueWakeItem({
				text: body.text,
				source: "hook",
				timestamp: new Date().toISOString(),
			});

			emitEvent(onEvent, "hook.queued", {
				hookSource: "wake",
			});
		}

		return c.json({ ok: true, mode });
	});

	// Agent endpoint
	app.post("/agent", async (c) => {
		const body = await c.req.json<{
			message: string;
			wakeMode?: "now" | "next-heartbeat";
			model?: string;
			maxIterations?: number;
			announce?: boolean;
		}>();

		if (!body.message) {
			return c.json({ error: "message is required" }, 400);
		}

		const wakeMode = body.wakeMode ?? "now";

		emitEvent(onEvent, "hook.received", {
			hookSource: "agent",
			wakeMode,
		});

		logger.info("Hook received: agent", {
			wakeMode,
			message: body.message.slice(0, 100),
		});

		if (wakeMode === "now") {
			// Submit directly to runner as isolated job
			const jobPromise = runner.execute({
				prompt: body.message,
				model: body.model,
				maxIterations: body.maxIterations,
				origin: {
					channel: "scheduler",
					replyTo: "hook:agent",
					from: "system",
					triggerType: "hook",
				},
			});

			// Wait briefly to get the job started
			await new Promise((r) => setTimeout(r, 50));

			// Don't block on job completion
			jobPromise.catch((err) => {
				logger.warn("Hook agent job failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});

			return c.json({ ok: true, wakeMode: "now" });
		}

		// Queue for next heartbeat
		heartbeat.queueWakeItem({
			text: body.message,
			source: "hook",
			timestamp: new Date().toISOString(),
		});

		emitEvent(onEvent, "hook.queued", {
			hookSource: "agent",
		});

		return c.json({ ok: true, wakeMode: "next-heartbeat" });
	});

	return app;
}

function emitEvent(
	handler: HookEventHandler | undefined,
	type: "hook.received" | "hook.queued",
	data: Record<string, unknown>,
): void {
	handler?.({
		type: type as RunnerEvent["type"],
		jobId: "hook",
		timestamp: new Date().toISOString(),
		data: data as RunnerEvent["data"],
	});
}

/**
 * Timing-safe token comparison.
 * Returns true only if both strings are defined, non-empty, and equal.
 * Uses fixed-length comparison to prevent length-based timing leaks.
 */
function tokensMatch(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const aBuf = Buffer.from(a, "utf-8");
	const bBuf = Buffer.from(b, "utf-8");
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}
