import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import { writeContext } from "@randal/runner";
import {
	Client,
	type Message as DiscordMessage,
	Events,
	GatewayIntentBits,
	Partials,
	type ThreadChannel,
} from "discord.js";
import { parseCommand } from "../router.js";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

/** Minimal sendable channel interface (avoids discord.js PartialGroupDMChannel issues) */
interface SendableChannel {
	send(content: string): Promise<unknown>;
}

/** Sendable channel that supports threads (guild text channels) */
interface ThreadableMessage {
	startThread(options: { name: string }): Promise<ThreadChannel>;
}

// Extract discord channel config type from the discriminated union
type DiscordChannelConfig = Extract<
	RandalConfig["gateway"]["channels"][number],
	{ type: "discord" }
>;

const DISCORD_MAX_LENGTH = 2000;

interface Conversation {
	threadChannel: ThreadChannel | null; // null for DMs
	history: Array<{ role: "user" | "assistant"; content: string }>;
	activeJobId: string | null;
}

export class DiscordChannel implements ChannelAdapter {
	readonly name = "discord";
	private client: Client;
	private unsubscribe?: () => void;
	private logger = createLogger({ context: { component: "channel:discord" } });
	// Map thread/DM channel ID → conversation state
	private conversations = new Map<string, Conversation>();
	// Map job ID → channel ID for routing events
	private jobToChannel = new Map<string, string>();

	constructor(
		private channelConfig: DiscordChannelConfig,
		private deps: ChannelDeps,
	) {
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.MessageContent,
			],
			partials: [Partials.Channel], // Required for DM support
		});
	}

	async start(): Promise<void> {
		// Register message handler
		this.client.on(Events.MessageCreate, (msg) => this.onMessage(msg));

		// Log when ready
		this.client.once(Events.ClientReady, (c) => {
			this.logger.info("Discord bot connected", { tag: c.user.tag });
		});

		// Login
		try {
			await this.client.login(this.channelConfig.token);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("disallowed intents") || msg.includes("Disallowed intent")) {
				const help = [
					"",
					"  \x1b[1m\x1b[31mDiscord bot failed: Privileged Gateway Intents are not enabled.\x1b[0m",
					"",
					"  Randal needs the \x1b[1mMessage Content Intent\x1b[0m to read messages.",
					"  Enable it in the Discord Developer Portal:",
					"",
					"    1. Go to \x1b[36mhttps://discord.com/developers/applications\x1b[0m",
					"    2. Select your bot application",
					"    3. Click \x1b[1mBot\x1b[0m in the left sidebar",
					"    4. Scroll to \x1b[1mPrivileged Gateway Intents\x1b[0m",
					"    5. Enable \x1b[1mMessage Content Intent\x1b[0m",
					"    6. Click \x1b[1mSave Changes\x1b[0m",
					"",
					"  Then restart randal.",
					"",
				].join("\n");
				console.error(help);
			}
			throw err;
		}

		// Subscribe to EventBus for outbound notifications
		this.unsubscribe = this.deps.eventBus.subscribe((event) => this.onRunnerEvent(event));
	}

	private async onMessage(msg: DiscordMessage): Promise<void> {
		this.logger.info("Discord message received", {
			author: msg.author.id,
			bot: msg.author.bot,
			guild: !!msg.guild,
			content: msg.content.slice(0, 50),
		});

		// Ignore bot messages
		if (msg.author.bot) return;

		const isDM = !msg.guild;
		const allowFrom = this.channelConfig.allowFrom;
		const isThread = msg.channel.isThread();
		const isKnownThread = isThread && this.conversations.has(msg.channel.id);

		// allowFrom filter
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(msg.author.id)) return;
		} else if (!isDM && !isKnownThread) {
			// No allowFrom + guild message + not a known thread: only respond if bot is mentioned
			const botUser = this.client.user;
			if (!botUser || !msg.mentions.has(botUser)) return;
		}

		// Strip bot mention from text
		let text = msg.content;
		const botUser = this.client.user;
		if (botUser) {
			text = text.replace(new RegExp(`<@!?${botUser.id}>`, "g"), "").trim();
		}

		if (!text) return;

		// Check for explicit commands (status, stop, jobs, etc.) — handle globally
		const parsed = parseCommand(text);
		if (parsed && parsed.command !== "run") {
			const origin = {
				channel: "discord" as const,
				replyTo: msg.channel.id,
				from: msg.author.id,
			};
			const response = await handleCommand(text, this.deps, origin);
			await msg.reply(response);
			return;
		}

		// Everything else is a conversation message
		const messageText = parsed?.args ?? text;

		if (isKnownThread || isDM) {
			// Continue existing conversation
			const channelId = msg.channel.id;
			await this.continueConversation(msg, channelId, messageText);
		} else {
			// New conversation from a guild channel — create a thread
			await this.startNewConversation(msg, messageText);
		}
	}

	/**
	 * Start a new conversation: create a thread (guild) or use the DM channel,
	 * submit the first job, and track the conversation.
	 */
	private async startNewConversation(msg: DiscordMessage, text: string): Promise<void> {
		const isDM = !msg.guild;

		// Build conversation history with just this first message
		const history: Conversation["history"] = [{ role: "user", content: text }];

		// Create origin pointing to where responses should go
		const origin = {
			channel: "discord" as const,
			replyTo: msg.channel.id,
			from: msg.author.id,
		};

		// Submit the job
		const { jobId, done } = this.deps.runner.submit({ prompt: text, origin });
		done.catch(() => {});

		// Try to create a thread (guild only)
		let threadChannel: ThreadChannel | null = null;
		let conversationChannelId: string;

		if (!isDM) {
			try {
				const threadName = this.generateThreadName(text);
				const startMsg = await msg.reply(`Starting: **${threadName}**`);
				if ("startThread" in startMsg) {
					threadChannel = await (startMsg as unknown as ThreadableMessage).startThread({
						name: threadName,
					});
					conversationChannelId = threadChannel.id;
				} else {
					conversationChannelId = msg.channel.id;
				}
			} catch {
				conversationChannelId = msg.channel.id;
			}
		} else {
			// DMs — use the DM channel as the conversation
			conversationChannelId = msg.channel.id;
			// For DMs, if this is the first message ever, register the channel
			if (!this.conversations.has(conversationChannelId)) {
				// Don't send "Starting:" for DMs — just let the response come through
			}
		}

		// Track the conversation
		this.conversations.set(conversationChannelId, {
			threadChannel,
			history,
			activeJobId: jobId,
		});
		this.jobToChannel.set(jobId, conversationChannelId);
	}

	/**
	 * Continue an existing conversation: include prior history in the prompt
	 * and submit a new job in the same thread.
	 */
	private async continueConversation(
		msg: DiscordMessage,
		channelId: string,
		text: string,
	): Promise<void> {
		const convo = this.conversations.get(channelId);

		// For DMs on first message, start a new conversation
		if (!convo) {
			await this.startNewConversation(msg, text);
			return;
		}

		// If a job is currently running, inject context
		if (convo.activeJobId) {
			const activeJob = this.deps.runner.getJob(convo.activeJobId);
			if (activeJob && (activeJob.status === "running" || activeJob.status === "queued")) {
				writeContext(activeJob.workdir, text);
				await msg.reply("*(sent to running agent)*");
				return;
			}
		}

		// Add user message to history
		convo.history.push({ role: "user", content: text });

		// Build a prompt that includes conversation history
		const prompt = this.buildConversationPrompt(convo.history);

		const origin = {
			channel: "discord" as const,
			replyTo: channelId,
			from: msg.author.id,
		};

		// Submit job with conversation context
		const { jobId, done } = this.deps.runner.submit({ prompt, origin });
		done.catch(() => {});

		// Update conversation state
		convo.activeJobId = jobId;
		this.jobToChannel.set(jobId, channelId);
	}

	/**
	 * Build a prompt that includes conversation history for context.
	 */
	private buildConversationPrompt(history: Conversation["history"]): string {
		if (history.length <= 1) {
			return history[0]?.content ?? "";
		}

		// Include recent history (last 10 exchanges to avoid token bloat)
		const recent = history.slice(-20);
		const contextLines = recent.map((entry) => {
			const prefix = entry.role === "user" ? "User" : "Assistant";
			return `${prefix}: ${entry.content}`;
		});

		return `## Conversation History\n${contextLines.join("\n\n")}\n\n## Current Request\nContinue the conversation. Respond to the user's latest message above.`;
	}

	/**
	 * Send a reply, splitting messages that exceed Discord's 2000 char limit.
	 */
	async sendReply(channel: SendableChannel, text: string): Promise<void> {
		if (text.length <= DISCORD_MAX_LENGTH) {
			await channel.send(text);
			return;
		}

		// Split on newline boundaries
		const chunks: string[] = [];
		let current = "";

		for (const line of text.split("\n")) {
			if (current.length + line.length + 1 > DISCORD_MAX_LENGTH) {
				if (current) {
					chunks.push(current);
					current = "";
				}
				// If a single line exceeds the limit, hard-split it
				if (line.length > DISCORD_MAX_LENGTH) {
					for (let i = 0; i < line.length; i += DISCORD_MAX_LENGTH) {
						chunks.push(line.slice(i, i + DISCORD_MAX_LENGTH));
					}
					continue;
				}
			}
			current = current ? `${current}\n${line}` : line;
		}
		if (current) chunks.push(current);

		for (const chunk of chunks) {
			await channel.send(chunk);
		}
	}

	/**
	 * Generate a human-readable thread name from a job prompt.
	 */
	private generateThreadName(prompt: string): string {
		let name = prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
		if (name.length > 80) {
			// Cut at word boundary to avoid mid-word truncation
			name = `${name.slice(0, 77).replace(/\s+\S*$/, "")}...`;
		}
		return name || "New task";
	}

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Look up the job to check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "discord") return;

		// Find the conversation channel for this job
		const channelId = this.jobToChannel.get(event.jobId);
		const convo = channelId ? this.conversations.get(channelId) : undefined;

		// Determine where to send: thread, or fallback to origin channel
		const target =
			convo?.threadChannel ??
			(channelId ? this.client.channels.cache.get(channelId) : null) ??
			this.client.channels.cache.get(job.origin.replyTo);
		if (!target || !("send" in target)) return;

		const sendable = target as SendableChannel;
		const message = formatEvent(event);

		// Update conversation history with assistant response
		if (convo && event.type === "job.complete") {
			const response = event.data.output || event.data.summary || message;
			convo.history.push({ role: "assistant", content: response });
			convo.activeJobId = null;
		} else if (convo && event.type === "job.failed") {
			convo.activeJobId = null;
		}

		this.sendReply(sendable, message).catch((err: unknown) => {
			this.logger.warn("Failed to send Discord notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
			});
		});

		// Clean up job mapping on terminal events (but keep conversation alive)
		if (event.type === "job.complete" || event.type === "job.failed") {
			this.jobToChannel.delete(event.jobId);
		}
	}

	stop(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		this.client.destroy();
		this.logger.info("Discord channel stopped");
	}
}
