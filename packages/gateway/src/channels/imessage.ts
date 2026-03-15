import { timingSafeEqual } from "node:crypto";
import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import { Hono } from "hono";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

/**
 * Constant-time string comparison for webhook secret validation.
 */
function safeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a), Buffer.from(b));
	} catch {
		return false;
	}
}

// Extract imessage channel config type from the discriminated union
type IMessageChannelConfig = Extract<
	RandalConfig["gateway"]["channels"][number],
	{ type: "imessage" }
>;

// ── BlueBubbles webhook payload types ───────────────────────

interface BlueBubblesWebhook {
	type: string;
	data: {
		chats?: Array<{ guid: string }>;
		handle?: { address: string };
		text?: string;
		isFromMe?: boolean;
	};
}

// ── iMessage prerequisites check ────────────────────────────

/**
 * Check if Messages.app has an active iMessage service.
 * macOS only — uses osascript to query Messages.app.
 * Returns false on non-macOS platforms.
 */
async function checkIMessageActive(): Promise<boolean> {
	if (process.platform !== "darwin") return false;

	try {
		const proc = Bun.spawnSync(
			[
				"osascript",
				"-e",
				'tell application "System Events" to (name of processes) contains "Messages"',
			],
			{ timeout: 3000 },
		);
		const output = proc.stdout.toString().trim().toLowerCase();
		return output === "true";
	} catch {
		return false;
	}
}

/**
 * Normalize a phone number for comparison by stripping non-digit characters
 * (except leading +).
 */
function normalizePhone(phone: string): string {
	const trimmed = phone.trim();
	if (trimmed.startsWith("+")) {
		return `+${trimmed.slice(1).replace(/\D/g, "")}`;
	}
	return trimmed.replace(/\D/g, "");
}

export class IMessageChannel implements ChannelAdapter {
	readonly name = "imessage";
	private unsubscribe?: () => void;
	private url: string;
	private password: string;
	private logger = createLogger({ context: { component: "channel:imessage" } });

	constructor(
		private channelConfig: IMessageChannelConfig,
		private deps: ChannelDeps,
	) {
		this.url = channelConfig.url.replace(/\/+$/, "");
		this.password = channelConfig.password;
	}

	/**
	 * Returns a Hono sub-app that handles BlueBubbles webhook POSTs.
	 * Mount at /webhooks/imessage BEFORE calling start().
	 */
	getWebhookRouter(): Hono {
		const router = new Hono();

		router.post("/", async (c) => {
			// Validate webhook secret if configured
			const secret = this.channelConfig.webhookSecret;
			if (secret) {
				const provided = c.req.header("X-Webhook-Secret");
				if (!provided || !safeCompare(provided, secret)) {
					return c.json({ error: "Unauthorized" }, 401);
				}
			}

			try {
				const body = await c.req.json<BlueBubblesWebhook>();
				// Process in background — always return 200 to BlueBubbles
				this.handleWebhook(body).catch((err) => {
					this.logger.error("Webhook processing failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			} catch {
				this.logger.warn("Invalid webhook payload");
			}
			return c.json({ ok: true });
		});

		return router;
	}

	async start(): Promise<void> {
		// macOS check
		if (process.platform !== "darwin") {
			this.logger.warn(
				"iMessage channel requires macOS with Messages.app. Current platform is not macOS.",
			);
		} else {
			const isActive = await checkIMessageActive();
			if (!isActive) {
				const appleId = process.env.APPLE_ID ?? "(not set)";
				this.logger.warn(
					`iMessage does not appear to be active. Ensure Messages.app is signed into Apple ID: ${appleId}`,
				);
			}
		}

		// Ping BlueBubbles server (with 3s timeout)
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 3000);
			const resp = await fetch(`${this.url}/api/v1/ping?password=${this.password}`, {
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (resp.ok) {
				this.logger.info("BlueBubbles server reachable", { url: this.url });
			} else {
				this.logger.warn("BlueBubbles server returned non-OK", {
					status: resp.status,
					url: this.url,
				});
			}
		} catch (err) {
			this.logger.warn("BlueBubbles server unreachable (non-fatal)", {
				url: this.url,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Subscribe to EventBus for outbound notifications
		this.unsubscribe = this.deps.eventBus.subscribe((event) => this.onRunnerEvent(event));
	}

	private async handleWebhook(payload: BlueBubblesWebhook): Promise<void> {
		// Only handle new messages
		if (payload.type !== "new-message") return;

		const data = payload.data;

		// Ignore own messages
		if (data.isFromMe) return;

		const text = data.text?.trim();
		if (!text) return;

		const chatGuid = data.chats?.[0]?.guid;
		const senderHandle = data.handle?.address;

		if (!chatGuid || !senderHandle) {
			this.logger.warn("Webhook missing chat guid or sender handle");
			return;
		}

		// allowFrom filter
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			const normalizedSender = normalizePhone(senderHandle);
			const allowed = allowFrom.some((allowed) => normalizePhone(allowed) === normalizedSender);
			if (!allowed) return;
		}

		const origin = {
			channel: "imessage" as const,
			replyTo: chatGuid,
			from: senderHandle,
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			await this.sendMessage(chatGuid, response);
		} catch (err) {
			this.logger.error("iMessage command handling failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Send a message via BlueBubbles REST API.
	 */
	async sendMessage(chatGuid: string, text: string): Promise<void> {
		try {
			const resp = await fetch(`${this.url}/api/v1/message/text?password=${this.password}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chatGuid,
					message: text,
					method: "private-api",
				}),
			});

			if (!resp.ok) {
				this.logger.warn("Failed to send iMessage", {
					status: resp.status,
					chatGuid,
				});
			}
		} catch (err) {
			this.logger.warn("Failed to send iMessage (network error)", {
				error: err instanceof Error ? err.message : String(err),
				chatGuid,
			});
		}
	}

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "imessage") return;

		const message = formatEvent(event);
		this.sendMessage(job.origin.replyTo, message).catch((err) => {
			this.logger.warn("Failed to send iMessage notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
			});
		});
	}

	stop(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		this.logger.info("iMessage channel stopped");
	}
}
