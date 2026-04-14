import { randomUUID, timingSafeEqual } from "node:crypto";
import { RANDAL_VERSION, createLogger } from "@randal/core";
import type { Job, RandalConfig, RunnerEvent, RunnerEventType } from "@randal/core";
import { auditCredentials, runAudit } from "@randal/credentials";
import {
	type MemoryManager,
	type MessageManager,
	type RegistryDoc,
	type SkillManager,
	queryPosseMembers,
	searchCrossAgent,
} from "@randal/memory";
import { type Runner, readLoopState, writeContext } from "@randal/runner";
import type { Scheduler } from "@randal/scheduler";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { EventBus } from "../events.js";
import { listJobs, loadJob, saveJob } from "../jobs.js";
import type { ChannelAdapter } from "./channel.js";

/**
 * Constant-time string comparison to prevent timing attacks on auth tokens.
 */
function safeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a), Buffer.from(b));
	} catch {
		return false;
	}
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Skill name validation pattern */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Zod schema for job annotation requests. */
const AnnotationSchema = z.object({
	verdict: z.enum(["pass", "fail", "partial"]),
	feedback: z.string().max(2000).optional(),
	categories: z.array(z.string().max(100)).max(10).optional(),
});

export interface HttpChannelOptions {
	config: RandalConfig;
	runner: Runner;
	eventBus: EventBus;
	memoryManager?: MemoryManager;
	messageManager?: MessageManager;
	scheduler?: Scheduler;
	skillManager?: SkillManager;
	/** Meilisearch client for posse registry queries. */
	posseClient?: unknown;
	/** Analytics engine instance (optional). */
	analyticsEngine?: {
		getScores(): {
			overall: number;
			byAgent: Record<string, number>;
			byModel: Record<string, number>;
			byDomain: Record<string, number>;
		} | null;
		getRecommendations(): Array<{
			severity: "info" | "warning" | "critical";
			message: string;
			action?: string;
		}>;
		getTrends(range?: string): unknown;
		getAnnotations(filters?: { jobId?: string; verdict?: string }): unknown[];
		addAnnotation(
			jobId: string,
			annotation: { verdict: string; feedback?: string; categories?: string[] },
		): boolean;
	};
	/** Mesh coordinator instance (optional). */
	meshCoordinator?: {
		getInstances(): Array<{
			id: string;
			name: string;
			status: string;
			health: string;
			load: number;
			role: string;
			expertise: string;
			lastSeen: string;
		}>;
		routeDryRun(prompt: string): Promise<{
			selectedInstance: { id: string; name: string; score: number };
			scores: unknown[];
		}>;
	};
	/** Voice channel manager instance (optional). */
	voiceManager?: {
		isEnabled(): boolean;
		getSessions(): Array<{
			id: string;
			callId: string;
			status: string;
			duration: number;
			transcriptLength: number;
			startedAt: string;
		}>;
	};
	/** Channel adapter registry for internal API dispatch. */
	channelAdapters?: ChannelAdapter[];
}

export function createHttpApp(options: HttpChannelOptions): Hono {
	const {
		config,
		runner,
		eventBus,
		memoryManager,
		messageManager,
		scheduler,
		skillManager,
		analyticsEngine,
		meshCoordinator,
		voiceManager,
	} = options;
	const app = new Hono();

	// Rate limiting for brain events: Map<"jobId:eventType", lastEmitTimestamp>
	const brainEventLastEmit = new Map<string, number>();
	const BRAIN_EVENT_RATE_LIMIT_MS = 10_000; // 1 per type per 10 seconds

	// Session store for cookie-based auth (avoids token in SSE query params)
	const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
	const sessions = new Map<string, { createdAt: number }>();

	// Periodic session cleanup (every 30 minutes)
	const sessionCleanupInterval = setInterval(
		() => {
			const now = Date.now();
			for (const [id, session] of sessions) {
				if (now - session.createdAt > SESSION_TTL_MS) {
					sessions.delete(id);
				}
			}
		},
		30 * 60 * 1000,
	);
	// Don't prevent process exit
	if (sessionCleanupInterval.unref) sessionCleanupInterval.unref();

	// CORS — configurable origin
	const httpChannel = config.gateway.channels.find((c) => c.type === "http");
	const corsOrigin = httpChannel?.type === "http" ? httpChannel.corsOrigin : undefined;
	app.use("*", cors({ origin: corsOrigin ?? "*" }));

	// Request body size limit (1MB)
	app.use("*", async (c, next) => {
		const contentLength = Number(c.req.header("content-length") ?? 0);
		if (contentLength > 1_048_576) {
			return c.json({ error: "Request body too large" }, 413);
		}
		await next();
	});

	// Auth middleware
	const authToken = httpChannel?.type === "http" ? httpChannel.auth : undefined;

	if (!authToken) {
		const logger = createLogger({ context: { component: "gateway" } });
		logger.warn(
			"HTTP API running without authentication. Set gateway.channels[http].auth in config.",
		);
	}

	// Protect all routes except root dashboard and health check
	app.use("*", async (c, next) => {
		const path = c.req.path;
		// Dashboard root and health endpoint are public (healthcheck probes send no auth)
		if (path === "/" || path === "/health" || path.startsWith("/_internal/")) {
			return next();
		}
		if (authToken) {
			// 1. Try session cookie first (no token in URL — preferred for SSE)
			const cookieHeader = c.req.header("Cookie") ?? "";
			const sessionMatch = cookieHeader.match(/randal_session=([^;]+)/);
			if (sessionMatch) {
				const sessionId = sessionMatch[1];
				const session = sessions.get(sessionId);
				if (session && Date.now() - session.createdAt < SESSION_TTL_MS) {
					return next();
				}
				// Expired or invalid session — fall through to token auth
			}

			// 2. Authorization header or ?token= query param
			const header = c.req.header("Authorization");
			const headerToken = header?.replace("Bearer ", "");
			const queryToken = new URL(c.req.url).searchParams.get("token");
			const token = headerToken || queryToken;
			if (!token || !safeCompare(token, authToken)) {
				return c.json({ error: "Unauthorized" }, 401);
			}
		}
		await next();
	});

	// Health check
	app.get("/health", (c) => {
		return c.json({
			status: "ok",
			uptime: process.uptime(),
			version: RANDAL_VERSION,
			updateChannel: config.updates.channel,
		});
	});

	// Session-based auth — exchange Bearer token for an HttpOnly session cookie
	// This allows SSE/EventSource to connect without exposing the token in the URL
	app.post("/auth/session", async (c) => {
		if (!authToken) {
			return c.json({ error: "Auth not configured" }, 400);
		}
		const header = c.req.header("Authorization");
		const bearerToken = header?.replace("Bearer ", "");
		if (!bearerToken || !safeCompare(bearerToken, authToken)) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const sessionId = randomUUID();
		sessions.set(sessionId, { createdAt: Date.now() });

		c.header(
			"Set-Cookie",
			`randal_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${c.req.header("X-Forwarded-Proto") === "https" ? "; Secure" : ""}`,
		);
		return c.json({ ok: true, expiresIn: SESSION_TTL_MS / 1000 });
	});

	// Ambient auth audit
	app.get("/audit", async (c) => {
		const report = await runAudit();
		return c.json(report);
	});

	// Instance info
	app.get("/instance", (c) => {
		const activeJobs = runner.getActiveJobs();
		const schedulerStatus = scheduler?.getStatus();

		// Include loop-state.json data for brain-managed job visibility
		let loopState = null;
		try {
			const state = readLoopState(config.runner.workdir);
			if (Object.keys(state.builds).length > 0) {
				loopState = state;
			}
		} catch {
			/* ok — workdir may not have .opencode yet */
		}

		return c.json({
			name: config.name,
			posse: config.posse,
			status: activeJobs.length > 0 ? "busy" : "idle",
			version: config.version,
			jobs: {
				active: activeJobs.length,
				total: listJobs().length,
			},
			capabilities: {
				tools: config.tools.map((t) => t.name),
				agent: config.runner.defaultAgent,
			},
			scheduler: schedulerStatus,
			loopState,
		});
	});

	// Submit job
	app.post("/job", async (c) => {
		const body = await c.req.json<{
			prompt?: string;
			specFile?: string;
			agent?: string;
			model?: string;
			maxIterations?: number;
			workdir?: string;
		}>();

		if (!body.prompt && !body.specFile) {
			return c.json({ error: "prompt or specFile required" }, 400);
		}

		// Input validation
		if (body.prompt && typeof body.prompt !== "string") {
			return c.json({ error: "prompt must be a string" }, 400);
		}
		if (body.maxIterations !== undefined) {
			const max = Number(body.maxIterations);
			if (Number.isNaN(max) || max < 1 || max > 100) {
				return c.json({ error: "maxIterations must be between 1 and 100" }, 400);
			}
		}

		// Submit job — returns immediately with job ID
		const { jobId, done } = runner.submit({
			prompt: body.prompt,
			specFile: body.specFile,
			agent: body.agent,
			model: body.model,
			maxIterations: body.maxIterations ? Math.min(Number(body.maxIterations), 100) : undefined,
			workdir: body.workdir,
		});

		// Persist initial state to disk
		const initialJob = runner.getJob(jobId);
		if (initialJob) {
			saveJob(initialJob);
		}

		// When job completes, update disk
		done.then((job) => saveJob(job)).catch(() => {});

		return c.json({ id: jobId, status: "queued" }, 201);
	});

	// Get job
	app.get("/job/:id", (c) => {
		const id = c.req.param("id");

		// Check active jobs first
		const activeJob = runner.getJob(id);
		if (activeJob) return c.json(activeJob);

		// Check disk
		const diskJob = loadJob(id);
		if (diskJob) return c.json(diskJob);

		return c.json({ error: "Job not found" }, 404);
	});

	// Get job plan (lightweight endpoint for polling/widgets)
	app.get("/job/:id/plan", (c) => {
		const id = c.req.param("id");

		const activeJob = runner.getJob(id);
		if (activeJob) return c.json(activeJob.plan);

		const diskJob = loadJob(id);
		if (diskJob) return c.json(diskJob.plan);

		return c.json({ error: "Job not found" }, 404);
	});

	// List jobs
	app.get("/jobs", (c) => {
		const statusFilter = c.req.query("status") as Job["status"] | undefined;
		const jobs = listJobs(statusFilter);

		// Merge with active jobs for latest state
		const active = runner.getActiveJobs();
		const activeIds = new Set(active.map((j) => j.id));

		const merged = [...active, ...jobs.filter((j) => !activeIds.has(j.id))];

		return c.json(merged);
	});

	// Stop job
	app.delete("/job/:id", (c) => {
		const id = c.req.param("id");
		const stopped = runner.stop(id);

		if (stopped) {
			return c.json({ id, status: "stopped" });
		}

		return c.json({ error: "Job not found or not running" }, 404);
	});

	// Inject context
	app.post("/job/:id/context", async (c) => {
		const id = c.req.param("id");
		const body = await c.req.json<{ text: string }>();

		if (!body.text) {
			return c.json({ error: "text required" }, 400);
		}

		const job = runner.getJob(id) ?? loadJob(id);
		if (!job) {
			return c.json({ error: "Job not found" }, 404);
		}

		writeContext(job.workdir, body.text);
		return c.json({ ok: true });
	});

	// SSE events (with event IDs for reconnection support)
	app.get("/events", (c) => {
		return streamSSE(c, async (stream) => {
			let eventId = 0;
			const unsub = eventBus.subscribe((event: RunnerEvent) => {
				stream.writeSSE({
					id: String(++eventId),
					event: event.type,
					data: JSON.stringify({
						jobId: event.jobId,
						...event.data,
					}),
				});
			});

			// Keep connection alive (15s to survive intermediate proxies)
			const keepAlive = setInterval(() => {
				stream.writeSSE({ event: "ping", data: "" });
			}, 15000);

			stream.onAbort(() => {
				unsub();
				clearInterval(keepAlive);
			});

			// Block to keep stream open
			await new Promise(() => {});
		});
	});

	// ---- Scheduler endpoints ----

	// Scheduler status
	app.get("/scheduler", (c) => {
		if (!scheduler) {
			return c.json({ error: "Scheduler not available" }, 400);
		}
		return c.json(scheduler.getStatus());
	});

	// Force heartbeat tick
	app.post("/heartbeat/trigger", async (c) => {
		if (!scheduler) {
			return c.json({ error: "Scheduler not available" }, 400);
		}
		const heartbeat = scheduler.getHeartbeat();
		await heartbeat.triggerNow();
		return c.json({ ok: true });
	});

	// Queue wake item for next heartbeat
	app.post("/heartbeat/wake", async (c) => {
		if (!scheduler) {
			return c.json({ error: "Scheduler not available" }, 400);
		}
		const body = await c.req.json<{ text: string }>();
		if (!body.text) {
			return c.json({ error: "text required" }, 400);
		}
		scheduler.getHeartbeat().queueWakeItem({
			text: body.text,
			source: "brain" as const,
			timestamp: new Date().toISOString(),
		});
		return c.json({ ok: true });
	});

	// List cron jobs
	app.get("/cron", (c) => {
		if (!scheduler) {
			return c.json({ error: "Scheduler not available" }, 400);
		}
		return c.json(scheduler.getCron().listJobs());
	});

	// Add cron job
	app.post("/cron", async (c) => {
		if (!scheduler) {
			return c.json({ error: "Scheduler not available" }, 400);
		}
		const body = await c.req.json<{
			name: string;
			schedule: string | { every: string } | { at: string };
			prompt: string;
			execution?: "main" | "isolated";
			model?: string;
			announce?: boolean;
		}>();

		if (!body.name || !body.prompt) {
			return c.json({ error: "name and prompt are required" }, 400);
		}

		scheduler.getCron().addJob({
			name: body.name,
			schedule: body.schedule ?? { every: "1h" },
			prompt: body.prompt,
			execution: body.execution ?? "isolated",
			model: body.model,
			announce: body.announce ?? false,
		});

		return c.json({ ok: true, name: body.name }, 201);
	});

	// Remove cron job
	app.delete("/cron/:name", (c) => {
		if (!scheduler) {
			return c.json({ error: "Scheduler not available" }, 400);
		}
		const name = c.req.param("name");
		const removed = scheduler.getCron().removeJob(name);
		if (removed) return c.json({ ok: true, name });
		return c.json({ error: "Cron job not found" }, 404);
	});

	// ---- Memory endpoints ----

	// Memory search
	app.get("/memory/search", async (c) => {
		const q = c.req.query("q");
		if (!q) return c.json({ error: "q parameter required" }, 400);

		const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

		if (memoryManager) {
			const results = await memoryManager.search(q, limit);
			return c.json(results);
		}
		return c.json([]);
	});

	// Memory recent
	app.get("/memory/recent", async (c) => {
		const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

		if (memoryManager) {
			const results = await memoryManager.recent(limit);
			return c.json(results);
		}
		return c.json([]);
	});

	// Memory add
	app.post("/memory", async (c) => {
		if (!memoryManager) return c.json({ error: "Memory not configured" }, 503);

		const body = (await c.req.json()) as {
			content: string;
			category?: string;
		};
		if (!body.content) return c.json({ error: "content required" }, 400);

		const category = body.category ?? "fact";
		const { createHash } = await import("node:crypto");
		const contentHash = createHash("sha256").update(body.content).digest("hex");

		await memoryManager.index({
			type: "learning",
			file: "api",
			content: body.content,
			contentHash,
			category: category as
				| "preference"
				| "pattern"
				| "fact"
				| "lesson"
				| "skill-outcome"
				| "escalation",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		return c.json({ saved: true, content: body.content, category });
	});

	// Memory delete
	app.delete("/memory/:id", async (c) => {
		if (!memoryManager) return c.json({ error: "Memory not configured" }, 503);
		// TODO: implement delete by ID
		return c.json({ error: "Not implemented" }, 501);
	});

	// ---- Message history endpoints ----

	// Add message
	app.post("/messages", async (c) => {
		if (!messageManager) return c.json({ error: "Message history not configured" }, 503);

		const body = (await c.req.json()) as {
			content: string;
			threadId: string;
			speaker?: string;
			channel?: string;
			jobId?: string;
			pendingAction?: string;
		};

		if (!body.content || !body.threadId) {
			return c.json({ error: "content and threadId required" }, 400);
		}

		const id = await messageManager.add({
			content: body.content,
			threadId: body.threadId,
			speaker: (body.speaker ?? "user") as import("@randal/core").MessageSpeaker,
			channel: body.channel ?? "api",
			timestamp: new Date().toISOString(),
			jobId: body.jobId,
			pendingAction: body.pendingAction,
		});

		return c.json({ id, threadId: body.threadId }, 201);
	});

	// Search messages
	app.get("/messages/search", async (c) => {
		if (!messageManager) return c.json([]);

		const q = c.req.query("q");
		if (!q) return c.json({ error: "q parameter required" }, 400);

		const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const results = await messageManager.search(q, limit);
		return c.json(results);
	});

	// Recent messages
	app.get("/messages/recent", async (c) => {
		if (!messageManager) return c.json([]);

		const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const results = await messageManager.recent(limit);
		return c.json(results);
	});

	// Get thread
	app.get("/messages/thread/:threadId", async (c) => {
		if (!messageManager) return c.json([]);

		const threadId = c.req.param("threadId");
		const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const results = await messageManager.thread(threadId, limit);
		return c.json(results);
	});

	// Pending actions
	app.get("/messages/pending", async (c) => {
		if (!messageManager) return c.json([]);

		const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const results = await messageManager.pending(limit);
		return c.json(results);
	});

	// Resolve pending action
	app.post("/messages/:id/resolve", async (c) => {
		if (!messageManager) return c.json({ error: "Message history not configured" }, 503);

		const id = c.req.param("id");
		await messageManager.resolvePending(id);
		return c.json({ ok: true, id });
	});

	// ---- Posse endpoints ----

	// Posse info (R5.1)
	app.get("/posse", async (c) => {
		if (!config.posse) {
			return c.json({ error: "Not a posse member" }, 404);
		}

		let agents: RegistryDoc[] = [];
		if (options.posseClient) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			agents = await queryPosseMembers(
				config,
				options.posseClient as Parameters<typeof queryPosseMembers>[1],
			);
		}

		return c.json({
			posse: config.posse,
			agents,
			self: config.name,
		});
	});

	// Posse memory search (R5.2)
	app.get("/posse/memory/search", async (c) => {
		if (!config.posse) {
			return c.json({ error: "Not a posse member" }, 404);
		}

		const q = c.req.query("q");
		if (!q) return c.json({ error: "q parameter required" }, 400);

		const scope = c.req.query("scope") ?? "self";
		const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

		if (scope === "self") {
			if (memoryManager) {
				const results = await memoryManager.search(q, limit);
				return c.json(results);
			}
			return c.json([]);
		}

		if (scope === "shared") {
			// Search only the shared posse index
			const readFrom = config.memory.sharing.readFrom.filter((idx) => idx.startsWith("shared-"));
			if (readFrom.length === 0) return c.json([]);

			try {
				const results = await searchCrossAgent(
					q,
					{
						...config,
						memory: { ...config.memory, sharing: { ...config.memory.sharing, readFrom } },
					},
					limit,
				);
				return c.json(results);
			} catch {
				return c.json([]);
			}
		}

		// scope === "all": search own + all sharing indexes
		if (memoryManager) {
			const ownResults = await memoryManager.search(q, limit);
			let crossResults: unknown[] = [];

			if (config.memory.sharing.readFrom.length > 0) {
				try {
					crossResults = await searchCrossAgent(q, config, limit);
				} catch {
					// Continue with own results only
				}
			}

			// Merge and deduplicate
			const seen = new Set<string>();
			const merged: unknown[] = [];

			for (const doc of ownResults as Array<{ contentHash?: string }>) {
				const hash = doc.contentHash;
				if (hash && seen.has(hash)) continue;
				if (hash) seen.add(hash);
				merged.push(doc);
			}

			for (const doc of crossResults as Array<{ contentHash?: string }>) {
				const hash = doc.contentHash;
				if (hash && seen.has(hash)) continue;
				if (hash) seen.add(hash);
				merged.push(doc);
			}

			return c.json(merged.slice(0, limit));
		}

		return c.json([]);
	});

	// Posse memory recent (R5.3)
	app.get("/posse/memory/recent", async (c) => {
		if (!config.posse) {
			return c.json({ error: "Not a posse member" }, 404);
		}

		const scope = c.req.query("scope") ?? "all";
		const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

		if (scope === "self" && memoryManager) {
			const results = await memoryManager.recent(limit);
			return c.json(results);
		}

		if (memoryManager) {
			const results = await memoryManager.recent(limit);
			return c.json(results);
		}

		return c.json([]);
	});

	// ---- Skills endpoints ----

	// List all skills
	app.get("/skills", async (c) => {
		if (!skillManager) {
			return c.json([]);
		}
		const skills = await skillManager.list();
		return c.json(
			skills.map((s) => ({
				name: s.meta.name,
				description: s.meta.description,
				tags: s.meta.tags ?? [],
				version: s.meta.version,
				updated: s.updated,
			})),
		);
	});

	// Search skills
	app.get("/skills/search", async (c) => {
		const q = c.req.query("q");
		if (!q) return c.json({ error: "q parameter required" }, 400);

		const limit = Number.parseInt(c.req.query("limit") ?? "5", 10);

		if (!skillManager) {
			return c.json([]);
		}

		const results = await skillManager.search(q, limit);
		return c.json(
			results.map((s) => ({
				name: s.meta.name,
				description: s.meta.description,
				tags: s.meta.tags ?? [],
				content: s.content,
				updated: s.updated,
			})),
		);
	});

	// Get skill by name
	app.get("/skills/:name", async (c) => {
		const name = c.req.param("name");

		if (!skillManager) {
			return c.json({ error: "Skills not available" }, 400);
		}

		const skill = await skillManager.getByName(name);
		if (!skill) {
			return c.json({ error: "Skill not found" }, 404);
		}

		return c.json({
			name: skill.meta.name,
			description: skill.meta.description,
			tags: skill.meta.tags ?? [],
			requires: skill.meta.requires,
			version: skill.meta.version,
			content: skill.content,
			filePath: skill.filePath,
			updated: skill.updated,
		});
	});

	// Create skill (write to disk)
	app.post("/skills", async (c) => {
		if (!skillManager) {
			return c.json({ error: "Skills not available" }, 400);
		}

		const body = await c.req.json<{
			name: string;
			description: string;
			content: string;
			tags?: string[];
		}>();

		if (!body.name || !body.description || !body.content) {
			return c.json({ error: "name, description, and content are required" }, 400);
		}

		// Validate skill name to prevent path traversal
		if (!SKILL_NAME_RE.test(body.name)) {
			return c.json({ error: "Skill name must match /^[a-z0-9][a-z0-9-]*$/" }, 400);
		}

		// Write skill file to disk
		const { mkdirSync, writeFileSync } = require("node:fs");
		const { resolve, join } = require("node:path");
		const { stringify: stringifyYaml } = require("yaml");

		const skillsDir = resolve(config.skills.dir);
		const skillDir = join(skillsDir, body.name);
		mkdirSync(skillDir, { recursive: true });

		const fm: Record<string, unknown> = {
			name: body.name,
			description: body.description,
		};
		if (body.tags) fm.tags = body.tags;

		const fileContent = `---\n${stringifyYaml(fm)}---\n\n${body.content}`;
		writeFileSync(join(skillDir, "SKILL.md"), fileContent);

		// Re-scan to pick up the new skill
		await skillManager.scanDirectory();

		return c.json({ ok: true, name: body.name }, 201);
	});

	// Delete skill
	app.delete("/skills/:name", async (c) => {
		const name = c.req.param("name");

		if (!skillManager) {
			return c.json({ error: "Skills not available" }, 400);
		}

		const skill = await skillManager.getByName(name);
		if (!skill) {
			return c.json({ error: "Skill not found" }, 404);
		}

		// Remove skill directory
		const { rmSync } = require("node:fs");
		const { dirname } = require("node:path");
		const skillDir = dirname(skill.filePath);

		try {
			rmSync(skillDir, { recursive: true, force: true });
		} catch {
			return c.json({ error: "Failed to delete skill" }, 500);
		}

		// Re-scan
		await skillManager.scanDirectory();

		return c.json({ ok: true, name });
	});

	// ---- Annotation endpoint ----

	// Annotate a completed job
	app.post("/job/:id/annotate", async (c) => {
		const id = c.req.param("id");

		// Find the job
		const job = runner.getJob(id) ?? loadJob(id);
		if (!job) {
			return c.json({ error: "Job not found" }, 404);
		}

		// Parse and validate body
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		const result = AnnotationSchema.safeParse(body);
		if (!result.success) {
			return c.json({ error: "Validation failed", details: result.error.issues }, 400);
		}

		const annotation = result.data;

		// Store annotation via analytics engine if available
		if (analyticsEngine) {
			analyticsEngine.addAnnotation(id, annotation);
		}

		return c.json({ ok: true, jobId: id, annotation });
	});

	// ---- Analytics endpoints ----

	// Reliability scores
	app.get("/analytics/scores", (c) => {
		if (!analyticsEngine) {
			return c.json({ status: "insufficient_data" });
		}

		const scores = analyticsEngine.getScores();
		if (!scores) {
			return c.json({ status: "insufficient_data" });
		}

		return c.json(scores);
	});

	// Recommendations
	app.get("/analytics/recommendations", (c) => {
		if (!analyticsEngine) {
			return c.json({ recommendations: [] });
		}

		const recommendations = analyticsEngine.getRecommendations();
		return c.json({ recommendations });
	});

	// Trends
	app.get("/analytics/trends", (c) => {
		if (!analyticsEngine) {
			return c.json({ trends: [], range: "7d" });
		}

		const range = c.req.query("range") ?? "7d";
		const trends = analyticsEngine.getTrends(range);
		return c.json(trends);
	});

	// Annotations list
	app.get("/analytics/annotations", (c) => {
		if (!analyticsEngine) {
			return c.json({ annotations: [] });
		}

		const jobId = c.req.query("jobId");
		const verdict = c.req.query("verdict");
		const filters: { jobId?: string; verdict?: string } = {};
		if (jobId) filters.jobId = jobId;
		if (verdict) filters.verdict = verdict;

		const annotations = analyticsEngine.getAnnotations(filters);
		return c.json({ annotations });
	});

	// ---- Mesh endpoints ----

	// Mesh status
	app.get("/mesh/status", (c) => {
		if (!meshCoordinator) {
			return c.json({ instances: [] });
		}

		const instances = meshCoordinator.getInstances();
		return c.json({ instances });
	});

	// Mesh route dry-run
	app.post("/mesh/route", async (c) => {
		if (!meshCoordinator) {
			return c.json({ error: "Mesh not available" }, 400);
		}

		const body = await c.req.json<{ prompt: string; dryRun?: boolean }>();
		if (!body.prompt) {
			return c.json({ error: "prompt required" }, 400);
		}

		const result = await meshCoordinator.routeDryRun(body.prompt);
		return c.json(result);
	});

	// ---- Voice endpoints ----

	// Voice session status
	app.get("/voice/status", (c) => {
		if (!voiceManager) {
			return c.json({ enabled: false, sessions: [] });
		}

		return c.json({
			enabled: voiceManager.isEnabled(),
			sessions: voiceManager.getSessions(),
		});
	});

	// Config (sanitized, read-only)
	app.get("/config", (c) => {
		const audit = auditCredentials(config);
		return c.json({
			name: config.name,
			version: config.version,
			posse: config.posse,
			runner: {
				defaultAgent: config.runner.defaultAgent,
				defaultModel: config.runner.defaultModel,
				defaultMaxIterations: config.runner.defaultMaxIterations,
				workdir: config.runner.workdir,
			},
			memory: {
				url: config.memory.url,
				index: config.memory.index,
			},
			skills: {
				dir: config.skills.dir,
				autoDiscover: config.skills.autoDiscover,
				maxPerPrompt: config.skills.maxPerPrompt,
			},
			tools: config.tools.map((t) => ({ name: t.name, binary: t.binary })),
			credentials: audit,
		});
	});

	// Dashboard - serve static HTML at root
	app.get("/", (c) => {
		try {
			const { getDashboardHtml } = require("@randal/dashboard");
			return c.html(getDashboardHtml());
		} catch {
			// Fallback minimal dashboard — escape config.name to prevent XSS
			const safeName = escapeHtml(config.name);
			return c.html(
				`<!DOCTYPE html><html><head><title>Randal</title></head><body><h1>${safeName} Dashboard</h1><p>Dashboard package not available.</p></body></html>`,
			);
		}
	});

	// ---- Internal API (channel awareness) ----

	// List connected channels
	app.get("/_internal/channels", (c) => {
		const adapters = options.channelAdapters ?? [];
		return c.json({
			channels: adapters.map((a) => ({
				name: a.name,
				canSend: typeof a.send === "function",
			})),
		});
	});

	// Send message to a channel
	app.post("/_internal/channel/send", async (c) => {
		const body = await c.req.json<{
			channel: string;
			target: string;
			message: string;
		}>();

		if (!body.channel || !body.target || !body.message) {
			return c.json({ error: "channel, target, and message are required" }, 400);
		}

		const adapters = options.channelAdapters ?? [];
		const adapter = adapters.find((a) => a.name === body.channel);

		if (!adapter) {
			return c.json({ error: `Channel "${body.channel}" not found` }, 404);
		}

		if (typeof adapter.send !== "function") {
			return c.json({ error: `Channel "${body.channel}" does not support send` }, 400);
		}

		try {
			await adapter.send(body.target, body.message);
			return c.json({ ok: true, channel: body.channel, target: body.target });
		} catch (err) {
			return c.json(
				{ error: `Send failed: ${err instanceof Error ? err.message : String(err)}` },
				500,
			);
		}
	});

	// ---- Internal API (brain event emission) ----

	// Brain event emission — called by emit_event MCP tool
	app.post("/_internal/events", async (c) => {
		const body = await c.req.json<{
			type: "notification" | "alert" | "progress";
			jobId: string;
			message: string;
			severity?: "info" | "warning" | "critical";
			targetChannel?: string;
		}>();

		// Validate required fields
		if (!body.type || !body.jobId || !body.message) {
			return c.json({ error: "type, jobId, and message are required" }, 400);
		}

		// Validate event type
		const validTypes = ["notification", "alert", "progress"];
		if (!validTypes.includes(body.type)) {
			return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` }, 400);
		}

		// Validate message length
		if (body.message.length > 2000) {
			return c.json({ error: "message must be <= 2000 characters" }, 400);
		}

		// Rate limiting: max 1 event per type per job per 10 seconds
		const rateKey = `${body.jobId}:${body.type}`;
		const lastEmit = brainEventLastEmit.get(rateKey);
		const now = Date.now();
		if (lastEmit && now - lastEmit < BRAIN_EVENT_RATE_LIMIT_MS) {
			const retryAfter = Math.ceil((BRAIN_EVENT_RATE_LIMIT_MS - (now - lastEmit)) / 1000);
			return c.json({ error: "Rate limited", retryAfterSeconds: retryAfter }, 429);
		}

		// Map short type to full RunnerEventType
		const fullType = `brain.${body.type}` as RunnerEventType;

		// Emit to EventBus
		eventBus.emit({
			type: fullType,
			jobId: body.jobId,
			timestamp: new Date().toISOString(),
			data: {
				message: body.message,
				severity: body.severity,
				targetChannel: body.targetChannel,
			},
		});

		brainEventLastEmit.set(rateKey, now);

		return c.json({ emitted: true, type: fullType, jobId: body.jobId });
	});

	return app;
}
