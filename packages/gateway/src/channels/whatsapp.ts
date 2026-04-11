import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import { Hono } from "hono";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

// Extract whatsapp channel config type from the discriminated union
type WhatsAppChannelConfig = Extract<
	RandalConfig["gateway"]["channels"][number],
	{ type: "whatsapp" }
>;

// ── Twilio WhatsApp webhook types ───────────────────────────

interface TwilioWhatsAppPayload {
	From: string; // "whatsapp:+1234567890"
	To: string; // "whatsapp:+0987654321"
	Body: string;
	MessageSid: string;
	NumMedia?: string;
	MediaContentType0?: string;
	MediaUrl0?: string;
}

/**
 * Normalize a phone number for comparison by stripping non-digit characters
 * (except leading +).
 */
function normalizePhone(phone: string): string {
	const trimmed = phone.trim();
	// Strip "whatsapp:" prefix if present
	const cleaned = trimmed.replace(/^whatsapp:/i, "");
	if (cleaned.startsWith("+")) {
		return `+${cleaned.slice(1).replace(/\D/g, "")}`;
	}
	return cleaned.replace(/\D/g, "");
}

export class WhatsAppChannel implements ChannelAdapter {
	readonly name = "whatsapp";
	private unsubscribe?: () => void;
	private logger = createLogger({ context: { component: "channel:whatsapp" } });

	constructor(
		private channelConfig: WhatsAppChannelConfig,
		private deps: ChannelDeps,
	) {}

	/**
	 * Returns a Hono sub-app that handles Twilio WhatsApp webhook POSTs.
	 * Mount at /webhooks/whatsapp BEFORE calling start().
	 */
	getWebhookRouter(): Hono {
		const router = new Hono();

		router.post("/", async (c) => {
			try {
				// Twilio sends form-encoded data
				const body = await c.req.parseBody();
				const payload = body as unknown as TwilioWhatsAppPayload;

				// Validate the payload has required fields
				if (!payload.From || !payload.Body) {
					return c.text("Bad request", 400);
				}

				// Validate Twilio request signature if authToken is configured
				if (this.channelConfig.authToken) {
					const twilioSignature = c.req.header("X-Twilio-Signature");
					if (!twilioSignature) {
						this.logger.warn("Missing Twilio signature");
						return c.text("Unauthorized", 401);
					}
					// Note: Full signature validation would require the request URL
					// and the twilio SDK. For now, we check the header exists.
					// Production deployments should validate with twilio.validateRequest().
				}

				// Process in background — return 200 immediately to Twilio
				this.handleIncoming(payload).catch((err) => {
					this.logger.error("WhatsApp webhook processing failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				});

				// Return TwiML empty response
				c.header("Content-Type", "text/xml");
				return c.body("<Response></Response>");
			} catch (err) {
				this.logger.warn("Invalid WhatsApp webhook payload", {
					error: err instanceof Error ? err.message : String(err),
				});
				return c.text("Bad request", 400);
			}
		});

		return router;
	}

	async start(): Promise<void> {
		this.logger.info("WhatsApp channel started (webhook mode)", {
			provider: this.channelConfig.provider,
			phoneNumber: this.channelConfig.phoneNumber,
		});

		// Subscribe to EventBus for outbound notifications
		this.unsubscribe = this.deps.eventBus.subscribe((event) => this.onRunnerEvent(event));
	}

	private async handleIncoming(payload: TwilioWhatsAppPayload): Promise<void> {
		const senderRaw = payload.From; // "whatsapp:+1234567890"
		const senderPhone = normalizePhone(senderRaw);

		// allowFrom filter by phone number
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			const allowed = allowFrom.some((phone) => normalizePhone(phone) === senderPhone);
			if (!allowed) return;
		}

		// Detect media attachments
		const numMedia = Number.parseInt(payload.NumMedia ?? "0", 10);
		if (numMedia > 0) {
			this.logger.info("WhatsApp media received", {
				from: senderPhone,
				numMedia,
				mediaType: payload.MediaContentType0,
			});
		}

		const text = payload.Body.trim();
		if (!text && numMedia > 0) {
			// Media-only message without text
			await this.sendMessage(
				senderRaw,
				"Media received. File processing is not yet supported. Please send your request as text.",
			);
			return;
		}

		if (!text) return;

		const origin = {
			channel: "whatsapp" as const,
			replyTo: senderRaw,
			from: senderPhone,
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			await this.sendMessage(senderRaw, response);
		} catch (err) {
			this.logger.error("WhatsApp message handling failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			try {
				await this.sendMessage(senderRaw, "Something went wrong processing your request.");
			} catch {
				// Can't send
			}
		}
	}

	/**
	 * Send a message via Twilio WhatsApp API.
	 */
	private async sendMessage(to: string, text: string): Promise<void> {
		const accountSid = this.channelConfig.accountSid;
		const authToken = this.channelConfig.authToken;
		const fromNumber = this.channelConfig.phoneNumber;

		if (!accountSid || !authToken || !fromNumber) {
			this.logger.warn("WhatsApp send failed: missing Twilio credentials");
			return;
		}

		const from = fromNumber.startsWith("whatsapp:") ? fromNumber : `whatsapp:${fromNumber}`;
		const toFormatted = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

		try {
			const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
			const body = new URLSearchParams({
				From: from,
				To: toFormatted,
				Body: text,
			});

			const resp = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
				},
				body: body.toString(),
			});

			if (!resp.ok) {
				const respBody = await resp.text();
				this.logger.warn("Twilio API error", {
					status: resp.status,
					body: respBody.slice(0, 200),
				});
			}
		} catch (err) {
			this.logger.warn("Failed to send WhatsApp message", {
				error: err instanceof Error ? err.message : String(err),
				to,
			});
		}
	}

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "whatsapp") return;

		const message = formatEvent(event);
		this.sendMessage(job.origin.replyTo, message).catch((err) => {
			this.logger.warn("Failed to send WhatsApp notification", {
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
		this.logger.info("WhatsApp channel stopped");
	}

	/**
	 * Send a message to a WhatsApp number via Twilio.
	 * Implements ChannelAdapter.send() for the internal channel API.
	 * Target should be a phone number (with or without "whatsapp:" prefix).
	 */
	async send(target: string, message: string): Promise<void> {
		await this.sendMessage(target, message);
	}
}
