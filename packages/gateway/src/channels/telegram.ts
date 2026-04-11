import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

// Extract telegram channel config type from the discriminated union
type TelegramChannelConfig = Extract<
	RandalConfig["gateway"]["channels"][number],
	{ type: "telegram" }
>;

// ── Telegraf type shims ─────────────────────────────────────
// These mirror the subset of telegraf's API we use.
// The actual Telegraf class is imported dynamically at start().

interface TelegrafContext {
	message?: {
		text?: string;
		voice?: { file_id: string; duration: number };
		from?: { id: number; username?: string; first_name?: string };
		chat: { id: number; type: string };
		document?: { file_name?: string; mime_type?: string };
		photo?: Array<{ file_id: string }>;
	};
	reply(text: string): Promise<unknown>;
}

interface TelegrafBot {
	on(event: string, handler: (ctx: TelegrafContext) => void): void;
	launch(): Promise<void>;
	stop(signal?: string): void;
	botInfo?: { id: number; username: string };
}

const TELEGRAM_MAX_LENGTH = 4096;

export class TelegramChannel implements ChannelAdapter {
	readonly name = "telegram";
	private bot?: TelegrafBot;
	private unsubscribe?: () => void;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private reconnectDelay = 1000;
	private stopping = false;
	private logger = createLogger({ context: { component: "channel:telegram" } });

	constructor(
		private channelConfig: TelegramChannelConfig,
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
			// Dynamic import — telegraf may not be installed
			const { Telegraf } = await import("telegraf");
			this.bot = new Telegraf(this.channelConfig.token) as unknown as TelegrafBot;

			// Text messages
			this.bot.on("text", (ctx) => this.onTextMessage(ctx));

			// Voice messages
			this.bot.on("voice", (ctx) => this.onVoiceMessage(ctx));

			// File/document messages
			this.bot.on("document", (ctx) => this.onDocumentMessage(ctx));

			// Photo messages
			this.bot.on("photo", (ctx) => this.onPhotoMessage(ctx));

			await this.bot.launch();
			this.reconnectDelay = 1000; // Reset on successful connect
			this.logger.info("Telegram bot connected", {
				username: this.bot.botInfo?.username,
			});
		} catch (err) {
			this.logger.error("Telegram connection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.stopping) return;
		this.logger.info("Scheduling Telegram reconnect", { delayMs: this.reconnectDelay });
		this.reconnectTimer = setTimeout(() => {
			this.connect().catch(() => {});
		}, this.reconnectDelay);
		// Exponential backoff: double delay, max 5 minutes
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5 * 60 * 1000);
	}

	private async onTextMessage(ctx: TelegrafContext): Promise<void> {
		const msg = ctx.message;
		if (!msg?.text || !msg.from) return;

		// allowFrom filter by Telegram user ID
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(String(msg.from.id))) return;
		}

		// In groups, only respond to messages that mention the bot
		const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
		let text = msg.text;
		if (isGroup) {
			const botUsername = this.bot?.botInfo?.username;
			if (botUsername) {
				const mentionPattern = new RegExp(`@${botUsername}\\b`, "i");
				if (!mentionPattern.test(text)) return;
				// Strip the mention from the text
				text = text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
			} else {
				// Can't determine bot username — ignore group messages
				return;
			}
		}

		if (!text) return;

		const origin = {
			channel: "telegram" as const,
			replyTo: String(msg.chat.id),
			from: String(msg.from.id),
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			await this.sendReply(ctx, response);
		} catch (err) {
			this.logger.error("Telegram message handling failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			try {
				await ctx.reply("Something went wrong processing your request.");
			} catch {
				// Can't reply
			}
		}
	}

	private async onVoiceMessage(ctx: TelegrafContext): Promise<void> {
		const msg = ctx.message;
		if (!msg?.voice || !msg.from) return;

		// allowFrom filter
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(String(msg.from.id))) return;
		}

		this.logger.info("Voice message received", {
			from: msg.from.id,
			duration: msg.voice.duration,
		});

		try {
			await ctx.reply(
				"Voice messages are detected but speech-to-text (STT) is not yet configured. Please send your request as text.",
			);
		} catch {
			// Can't reply
		}
	}

	private async onDocumentMessage(ctx: TelegrafContext): Promise<void> {
		const msg = ctx.message;
		if (!msg?.document || !msg.from) return;

		// allowFrom filter
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(String(msg.from.id))) return;
		}

		this.logger.info("Document received", {
			from: msg.from.id,
			fileName: msg.document.file_name,
			mimeType: msg.document.mime_type,
		});

		try {
			await ctx.reply(
				`File "${msg.document.file_name ?? "unknown"}" received. File processing is not yet supported. Please describe your request as text.`,
			);
		} catch {
			// Can't reply
		}
	}

	private async onPhotoMessage(ctx: TelegrafContext): Promise<void> {
		const msg = ctx.message;
		if (!msg?.photo || !msg.from) return;

		// allowFrom filter
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(String(msg.from.id))) return;
		}

		this.logger.info("Photo received", { from: msg.from.id });

		try {
			await ctx.reply(
				"Photo received. Image processing is not yet supported. " +
					"Please describe your request as text.",
			);
		} catch {
			// Can't reply
		}
	}

	/**
	 * Send a reply, splitting messages that exceed Telegram's 4096 char limit.
	 */
	private async sendReply(ctx: TelegrafContext, text: string): Promise<void> {
		if (text.length <= TELEGRAM_MAX_LENGTH) {
			await ctx.reply(text);
			return;
		}

		// Split on newline boundaries
		const chunks: string[] = [];
		let current = "";

		for (const line of text.split("\n")) {
			if (current.length + line.length + 1 > TELEGRAM_MAX_LENGTH) {
				if (current) {
					chunks.push(current);
					current = "";
				}
				// If a single line exceeds the limit, hard-split it
				if (line.length > TELEGRAM_MAX_LENGTH) {
					for (let i = 0; i < line.length; i += TELEGRAM_MAX_LENGTH) {
						chunks.push(line.slice(i, i + TELEGRAM_MAX_LENGTH));
					}
					continue;
				}
			}
			current = current ? `${current}\n${line}` : line;
		}
		if (current) chunks.push(current);

		for (const chunk of chunks) {
			await ctx.reply(chunk);
		}
	}

	/**
	 * Send a message to a specific chat by ID (for event notifications).
	 */
	private async sendMessage(chatId: string, text: string): Promise<void> {
		if (!this.bot) return;
		try {
			// Use the Telegraf instance's telegram API to send to a specific chat
			const bot = this.bot as unknown as {
				telegram: { sendMessage(chatId: string, text: string): Promise<unknown> };
			};
			if (text.length <= TELEGRAM_MAX_LENGTH) {
				await bot.telegram.sendMessage(chatId, text);
			} else {
				// Split long messages
				const chunks: string[] = [];
				let current = "";
				for (const line of text.split("\n")) {
					if (current.length + line.length + 1 > TELEGRAM_MAX_LENGTH) {
						if (current) {
							chunks.push(current);
							current = "";
						}
						if (line.length > TELEGRAM_MAX_LENGTH) {
							for (let i = 0; i < line.length; i += TELEGRAM_MAX_LENGTH) {
								chunks.push(line.slice(i, i + TELEGRAM_MAX_LENGTH));
							}
							continue;
						}
					}
					current = current ? `${current}\n${line}` : line;
				}
				if (current) chunks.push(current);
				for (const chunk of chunks) {
					await bot.telegram.sendMessage(chatId, chunk);
				}
			}
		} catch (err) {
			this.logger.warn("Failed to send Telegram message", {
				error: err instanceof Error ? err.message : String(err),
				chatId,
			});
		}
	}

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "telegram") return;

		const message = formatEvent(event);
		this.sendMessage(job.origin.replyTo, message).catch((err) => {
			this.logger.warn("Failed to send Telegram notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
			});
		});
	}

	stop(): void {
		this.stopping = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		if (this.bot) {
			try {
				this.bot.stop("SIGTERM");
			} catch {
				// Bot may not have started polling successfully — safe to ignore
			}
			this.bot = undefined;
		}
		this.logger.info("Telegram channel stopped");
	}

	/**
	 * Send a message to a Telegram chat by ID.
	 * Implements ChannelAdapter.send() for the internal channel API.
	 */
	async send(target: string, message: string): Promise<void> {
		await this.sendMessage(target, message);
	}
}
