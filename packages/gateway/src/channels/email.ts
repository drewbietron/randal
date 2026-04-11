import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

// Extract email channel config type from the discriminated union
type EmailChannelConfig = Extract<RandalConfig["gateway"]["channels"][number], { type: "email" }>;

// ── imapflow / nodemailer type shims ────────────────────────
// These mirror the subset of the libraries' APIs we use.
// The actual classes are imported dynamically at start().

interface ImapMessage {
	uid: number;
	envelope: {
		from?: Array<{ address?: string; name?: string }>;
		subject?: string;
		messageId?: string;
		inReplyTo?: string;
	};
	source: Buffer;
}

interface ImapFetchOptions {
	uid: boolean;
	envelope: boolean;
	source: boolean;
}

interface ImapClient {
	connect(): Promise<void>;
	logout(): Promise<void>;
	getMailboxLock(mailbox: string): Promise<{ release(): void }>;
	idle(): Promise<void>;
	fetch(range: string, opts: ImapFetchOptions): AsyncIterable<ImapMessage>;
	messageFlagsAdd(range: string, flags: string[], opts?: { uid: boolean }): Promise<void>;
	on(event: string, handler: (...args: unknown[]) => void): void;
	authenticated: boolean;
}

interface SmtpTransporter {
	sendMail(opts: {
		from: string;
		to: string;
		subject: string;
		text: string;
		inReplyTo?: string;
		references?: string;
	}): Promise<{ messageId: string }>;
	close(): void;
}

/**
 * Parse the subject line for a command prefix.
 * Examples:
 *   "run: build the API" → "run: build the API"
 *   "status" → "status"
 *   "Re: run: build the API" → "run: build the API" (strips Re:/Fwd:)
 */
function parseSubjectCommand(subject: string): string {
	// Strip common reply/forward prefixes
	return subject.replace(/^(Re|Fwd|Fw):\s*/gi, "").trim();
}

/**
 * Extract plain text body from a raw email source.
 * Simple extraction — finds the text/plain part.
 */
function extractPlainTextBody(source: Buffer): string {
	const raw = source.toString("utf-8");

	// Try to find a plain text MIME boundary
	const boundaryMatch = raw.match(/boundary="?([^"\r\n]+)"?/);
	if (boundaryMatch) {
		const boundary = boundaryMatch[1];
		const parts = raw.split(`--${boundary}`);
		for (const part of parts) {
			if (part.includes("Content-Type: text/plain") || part.includes("content-type: text/plain")) {
				// Extract content after the headers (blank line separator)
				const headerEnd = part.indexOf("\r\n\r\n");
				if (headerEnd !== -1) {
					return part
						.slice(headerEnd + 4)
						.replace(/--$/, "")
						.trim();
				}
			}
		}
	}

	// No MIME boundaries — try to extract body after headers
	const headerEnd = raw.indexOf("\r\n\r\n");
	if (headerEnd !== -1) {
		return raw.slice(headerEnd + 4).trim();
	}

	return raw.trim();
}

export class EmailChannel implements ChannelAdapter {
	readonly name = "email";
	private imapClient?: ImapClient;
	private smtpTransporter?: SmtpTransporter;
	private unsubscribe?: () => void;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private reconnectDelay = 1000;
	private stopping = false;
	private idleActive = false;
	private logger = createLogger({ context: { component: "channel:email" } });

	constructor(
		private channelConfig: EmailChannelConfig,
		private deps: ChannelDeps,
	) {}

	async start(): Promise<void> {
		this.stopping = false;
		await this.connect();

		// Subscribe to EventBus for outbound notifications
		this.unsubscribe = this.deps.eventBus.subscribe((event) => this.onRunnerEvent(event));
	}

	private async connect(): Promise<void> {
		try {
			// Dynamic import — imapflow and nodemailer may not be installed
			const { ImapFlow } = await import("imapflow");
			const nodemailer = await import("nodemailer");

			// IMAP client for receiving
			this.imapClient = new ImapFlow({
				host: this.channelConfig.imap.host,
				port: this.channelConfig.imap.port,
				secure: this.channelConfig.imap.tls,
				auth: {
					user: this.channelConfig.imap.user,
					pass: this.channelConfig.imap.password,
				},
				logger: false,
			}) as unknown as ImapClient;

			// SMTP transporter for sending
			this.smtpTransporter = nodemailer.createTransport({
				host: this.channelConfig.smtp.host,
				port: this.channelConfig.smtp.port,
				secure: this.channelConfig.smtp.secure,
				auth: {
					user: this.channelConfig.smtp.user,
					pass: this.channelConfig.smtp.password,
				},
			}) as unknown as SmtpTransporter;

			await this.imapClient.connect();
			this.reconnectDelay = 1000; // Reset on successful connect
			this.logger.info("Email channel connected", {
				imapHost: this.channelConfig.imap.host,
				smtpHost: this.channelConfig.smtp.host,
			});

			// Listen for connection errors
			this.imapClient.on("error", (err: unknown) => {
				this.logger.error("IMAP connection error", {
					error: err instanceof Error ? (err as Error).message : String(err),
				});
				if (!this.stopping) {
					this.scheduleReconnect();
				}
			});

			this.imapClient.on("close", () => {
				this.logger.info("IMAP connection closed");
				if (!this.stopping) {
					this.scheduleReconnect();
				}
			});

			// Start IDLE loop for real-time monitoring
			this.startIdleLoop().catch((err) => {
				this.logger.error("IDLE loop failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		} catch (err) {
			this.logger.error("Email connection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.stopping) return;
		this.idleActive = false;
		this.logger.info("Scheduling email reconnect", { delayMs: this.reconnectDelay });
		this.reconnectTimer = setTimeout(() => {
			this.connect().catch(() => {});
		}, this.reconnectDelay);
		// Exponential backoff: double delay, max 5 minutes
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5 * 60 * 1000);
	}

	/**
	 * IMAP IDLE loop: wait for new messages, process them, repeat.
	 */
	private async startIdleLoop(): Promise<void> {
		if (!this.imapClient || this.stopping) return;

		this.idleActive = true;
		const lock = await this.imapClient.getMailboxLock("INBOX");

		try {
			// Process any unread messages that arrived while we were disconnected
			await this.processUnread();

			while (this.idleActive && !this.stopping) {
				try {
					// IDLE waits until a new message arrives or connection event
					await this.imapClient.idle();
					// After IDLE returns, check for new messages
					await this.processUnread();
				} catch (err) {
					if (this.stopping) break;
					this.logger.error("IDLE iteration error", {
						error: err instanceof Error ? err.message : String(err),
					});
					break;
				}
			}
		} finally {
			lock.release();
		}
	}

	/**
	 * Fetch and process all unseen messages in INBOX.
	 */
	private async processUnread(): Promise<void> {
		if (!this.imapClient) return;

		try {
			for await (const msg of this.imapClient.fetch("1:* NOT SEEN", {
				uid: true,
				envelope: true,
				source: true,
			})) {
				await this.handleEmail(msg);
				// Mark as seen
				await this.imapClient.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true });
			}
		} catch (err) {
			this.logger.error("Failed to process unread emails", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleEmail(msg: ImapMessage): Promise<void> {
		const sender = msg.envelope.from?.[0]?.address;
		if (!sender) {
			this.logger.warn("Email missing sender address");
			return;
		}

		// allowFrom filter by email address
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			const normalizedSender = sender.toLowerCase();
			const allowed = allowFrom.some((addr) => addr.toLowerCase() === normalizedSender);
			if (!allowed) return;
		}

		const subject = msg.envelope.subject ?? "";
		const body = extractPlainTextBody(msg.source);

		// Parse subject for command (e.g., "run: build the API")
		const subjectCommand = parseSubjectCommand(subject);

		// Use subject as the command text, with body as additional prompt context
		let commandText: string;
		if (subjectCommand) {
			commandText = body ? `${subjectCommand}\n\n${body}` : subjectCommand;
		} else if (body) {
			commandText = body;
		} else {
			this.logger.warn("Email with no subject or body", { from: sender });
			return;
		}

		const origin = {
			channel: "email" as const,
			replyTo: sender,
			from: sender,
		};

		try {
			const response = await handleCommand(commandText, this.deps, origin);
			await this.sendReplyEmail(
				sender,
				subject ? `Re: ${subject}` : "Randal Response",
				response,
				msg.envelope.messageId,
			);
		} catch (err) {
			this.logger.error("Email command handling failed", {
				error: err instanceof Error ? err.message : String(err),
				from: sender,
			});
		}
	}

	/**
	 * Send a reply email via SMTP.
	 */
	private async sendReplyEmail(
		to: string,
		subject: string,
		text: string,
		inReplyTo?: string,
	): Promise<void> {
		if (!this.smtpTransporter) {
			this.logger.warn("SMTP transporter not available");
			return;
		}

		try {
			await this.smtpTransporter.sendMail({
				from: this.channelConfig.smtp.user,
				to,
				subject,
				text,
				inReplyTo,
				references: inReplyTo,
			});
		} catch (err) {
			this.logger.warn("Failed to send reply email", {
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
		if (!job?.origin || job.origin.channel !== "email") return;

		const message = formatEvent(event);
		this.sendReplyEmail(
			job.origin.replyTo,
			`Randal: ${event.type} — Job ${event.jobId}`,
			message,
		).catch((err) => {
			this.logger.warn("Failed to send email notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
			});
		});
	}

	stop(): void {
		this.stopping = true;
		this.idleActive = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		if (this.imapClient) {
			this.imapClient.logout().catch((err) => {
				this.logger.warn("Error closing IMAP connection", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			this.imapClient = undefined;
		}
		if (this.smtpTransporter) {
			this.smtpTransporter.close();
			this.smtpTransporter = undefined;
		}
		this.logger.info("Email channel stopped");
	}

	/**
	 * Send an email to a recipient address.
	 * Implements ChannelAdapter.send() for the internal channel API.
	 * Target is the recipient email address.
	 */
	async send(target: string, message: string): Promise<void> {
		await this.sendReplyEmail(target, "Message from Randal", message);
	}
}
