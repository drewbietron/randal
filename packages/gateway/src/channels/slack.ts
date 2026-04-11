import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

// Extract slack channel config type from the discriminated union
type SlackChannelConfig = Extract<RandalConfig["gateway"]["channels"][number], { type: "slack" }>;

// ── Slack Bolt type shims ───────────────────────────────────
// These mirror the subset of @slack/bolt's API we use.
// The actual App class is imported dynamically at start().

interface SlackMessageEvent {
	text?: string;
	user?: string;
	channel: string;
	thread_ts?: string;
	ts: string;
	bot_id?: string;
	channel_type?: string;
}

interface SlackAppMentionEvent {
	text: string;
	user: string;
	channel: string;
	thread_ts?: string;
	ts: string;
}

interface SlackCommandPayload {
	command: string;
	text: string;
	user_id: string;
	channel_id: string;
	trigger_id: string;
}

type SlackSay = (message: string | { text: string; thread_ts?: string }) => Promise<unknown>;

type SlackAck = (response?: string | { text: string }) => Promise<void>;

interface SlackApp {
	event(
		eventName: string,
		handler: (args: {
			event: SlackMessageEvent | SlackAppMentionEvent;
			say: SlackSay;
		}) => Promise<void>,
	): void;
	command(
		command: string,
		handler: (args: {
			command: SlackCommandPayload;
			ack: SlackAck;
			say: SlackSay;
		}) => Promise<void>,
	): void;
	start(): Promise<unknown>;
	stop(): Promise<void>;
	client: {
		chat: {
			postMessage(opts: { channel: string; text: string; thread_ts?: string }): Promise<unknown>;
		};
	};
}

export class SlackChannel implements ChannelAdapter {
	readonly name = "slack";
	private app?: SlackApp;
	private unsubscribe?: () => void;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private reconnectDelay = 1000;
	private stopping = false;
	private logger = createLogger({ context: { component: "channel:slack" } });

	constructor(
		private channelConfig: SlackChannelConfig,
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
			// Dynamic import — @slack/bolt may not be installed
			const { App } = await import("@slack/bolt");
			this.app = new App({
				token: this.channelConfig.botToken,
				appToken: this.channelConfig.appToken,
				signingSecret: this.channelConfig.signingSecret,
				socketMode: true,
			}) as unknown as SlackApp;

			// Direct messages and channel messages
			this.app.event("message", async ({ event, say }) => {
				await this.onMessage(event as SlackMessageEvent, say);
			});

			// App mentions (@randal)
			this.app.event("app_mention", async ({ event, say }) => {
				await this.onAppMention(event as SlackAppMentionEvent, say);
			});

			// Slash commands: /randal run <prompt>, /randal status [job-id]
			this.app.command("/randal", async ({ command, ack, say }) => {
				await this.onSlashCommand(command, ack, say);
			});

			await this.app.start();
			this.reconnectDelay = 1000; // Reset on successful connect
			this.logger.info("Slack bot connected (Socket Mode)");
		} catch (err) {
			this.logger.error("Slack connection failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.stopping) return;
		this.logger.info("Scheduling Slack reconnect", { delayMs: this.reconnectDelay });
		this.reconnectTimer = setTimeout(() => {
			this.connect().catch(() => {});
		}, this.reconnectDelay);
		// Exponential backoff: double delay, max 5 minutes
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5 * 60 * 1000);
	}

	private async onMessage(event: SlackMessageEvent, say: SlackSay): Promise<void> {
		// Ignore bot messages
		if (event.bot_id) return;

		const userId = event.user;
		if (!userId) return;

		// allowFrom filter
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(userId)) return;
		}

		const text = event.text?.trim();
		if (!text) return;

		// In channels (non-DM), only respond if directly addressed
		// DMs (channel_type === "im") always pass through
		if (event.channel_type !== "im") return;

		const origin = {
			channel: "slack" as const,
			replyTo: event.channel,
			from: userId,
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			// Reply in thread if message is in a thread
			if (event.thread_ts) {
				await say({ text: response, thread_ts: event.thread_ts });
			} else {
				await say(response);
			}
		} catch (err) {
			this.logger.error("Slack message handling failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			try {
				await say("Something went wrong processing your request.");
			} catch {
				// Can't reply
			}
		}
	}

	private async onAppMention(event: SlackAppMentionEvent, say: SlackSay): Promise<void> {
		const userId = event.user;

		// allowFrom filter
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(userId)) return;
		}

		// Strip the bot mention from the text
		// Slack mentions look like <@U01234ABCDE>
		const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
		if (!text) return;

		const origin = {
			channel: "slack" as const,
			replyTo: event.channel,
			from: userId,
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			if (event.thread_ts) {
				await say({ text: response, thread_ts: event.thread_ts });
			} else {
				await say({ text: response, thread_ts: event.ts });
			}
		} catch (err) {
			this.logger.error("Slack app_mention handling failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			try {
				await say("Something went wrong processing your request.");
			} catch {
				// Can't reply
			}
		}
	}

	private async onSlashCommand(
		command: SlackCommandPayload,
		ack: SlackAck,
		say: SlackSay,
	): Promise<void> {
		const userId = command.user_id;

		// allowFrom filter
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(userId)) {
				await ack({ text: "You are not authorized to use this command." });
				return;
			}
		}

		const rawText = command.text.trim();
		// Parse subcommand: /randal run <prompt> or /randal status [id]
		// If no subcommand, treat as implicit run
		let text: string;
		if (rawText.startsWith("run ") || rawText.startsWith("run:")) {
			text = rawText;
		} else if (
			rawText === "status" ||
			rawText.startsWith("status ") ||
			rawText.startsWith("status:")
		) {
			text = rawText;
		} else if (rawText === "stop" || rawText.startsWith("stop ")) {
			text = rawText;
		} else if (rawText === "jobs") {
			text = rawText;
		} else if (rawText === "help") {
			text = rawText;
		} else {
			// Treat as implicit run
			text = rawText;
		}

		// Acknowledge immediately (Slack requires a response within 3s)
		await ack();

		const origin = {
			channel: "slack" as const,
			replyTo: command.channel_id,
			from: userId,
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			await say(response);
		} catch (err) {
			this.logger.error("Slack slash command failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			try {
				await say("Something went wrong processing your command.");
			} catch {
				// Can't reply
			}
		}
	}

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "slack") return;

		if (!this.app) return;

		const message = formatEvent(event);
		this.app.client.chat
			.postMessage({
				channel: job.origin.replyTo,
				text: message,
			})
			.catch((err: unknown) => {
				this.logger.warn("Failed to send Slack notification", {
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
		if (this.app) {
			this.app.stop().catch((err) => {
				this.logger.warn("Error stopping Slack app", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			this.app = undefined;
		}
		this.logger.info("Slack channel stopped");
	}

	/**
	 * Send a message to a Slack channel/thread by ID.
	 * Implements ChannelAdapter.send() for the internal channel API.
	 */
	async send(target: string, message: string): Promise<void> {
		if (!this.app) {
			throw new Error("Slack app not connected");
		}
		await this.app.client.chat.postMessage({
			channel: target,
			text: message,
		});
	}
}
