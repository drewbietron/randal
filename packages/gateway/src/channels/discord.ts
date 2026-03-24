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
	// Map job ID → typing interval for "is typing..." indicator
	private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
	// Map job ID → progress state for edit-in-place status messages
	private progressState = new Map<
		string,
		{
			// biome-ignore lint: discord.js Message type varies
			message: any;
			latestProgress: string | null;
			plan: Array<{ task: string; status: string }> | null;
			iteration: number;
			maxIterations: number;
			lastEditAt: number;
			pendingUpdate: ReturnType<typeof setTimeout> | null;
		}
	>();

	/** Minimum ms between Discord message edits (avoid rate limits) */
	private static readonly EDIT_DEBOUNCE_MS = 2000;

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

		// Log when ready, then preload recent conversations from Meilisearch
		this.client.once(Events.ClientReady, (c) => {
			this.logger.info("Discord bot connected", { tag: c.user.tag });
			this.preloadConversations().catch((err) => {
				this.logger.warn("Failed to preload conversations on startup", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
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

	/**
	 * Preload recent conversations from Meilisearch on startup.
	 * This ensures that when a user messages in a thread after a gateway restart,
	 * the full conversation history is available even if no job was running at the
	 * time of the restart.
	 */
	private async preloadConversations(): Promise<void> {
		const mm = this.deps.messageManager;
		if (!mm) return;

		const threadIds = await mm.recentThreadIds(100);
		if (threadIds.length === 0) return;

		let loaded = 0;
		for (const threadId of threadIds) {
			// Skip threads we already have in memory (e.g. from recoverJob)
			if (this.conversations.has(threadId)) continue;

			try {
				const msgs = await mm.thread(threadId);
				if (msgs.length === 0) continue;

				const history = msgs.map((m) => ({
					role: m.speaker === "user" ? ("user" as const) : ("assistant" as const),
					content: m.content,
				}));

				// Try to fetch the thread channel from Discord (non-blocking on failure)
				let threadChannel: ThreadChannel | null = null;
				try {
					const channel = await this.client.channels.fetch(threadId);
					if (channel?.isThread()) {
						threadChannel = channel as ThreadChannel;
					}
				} catch {
					// Thread may have been deleted or bot lost access — that's fine
				}

				this.conversations.set(threadId, {
					threadChannel,
					history,
					activeJobId: null,
				});
				loaded++;
			} catch (err) {
				this.logger.debug("Failed to preload conversation", {
					threadId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		this.logger.info("Preloaded conversations from Meilisearch", {
			total: threadIds.length,
			loaded,
			alreadyKnown: threadIds.length - loaded,
		});
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
		let isKnownThread = isThread && this.conversations.has(msg.channel.id);

		// Recover thread state after gateway restart: if this is a thread
		// we don't have in memory, check Meilisearch for prior conversation history.
		// This handles both bot-owned threads AND any thread the bot has chatted in.
		if (isThread && !isKnownThread) {
			const threadChannel = msg.channel as ThreadChannel;
			const mm = this.deps.messageManager;
			if (mm) {
				try {
					const msgs = await mm.thread(threadChannel.id);
					if (msgs.length > 0) {
						const history = msgs.map((m) => ({
							role: m.speaker === "user" ? ("user" as const) : ("assistant" as const),
							content: m.content,
						}));
						this.conversations.set(threadChannel.id, {
							threadChannel,
							history,
							activeJobId: null,
						});
						isKnownThread = true;
						this.logger.info("Recovered conversation from Meilisearch", {
							threadId: threadChannel.id,
							messageCount: msgs.length,
						});
					}
				} catch (err) {
					this.logger.warn("Failed to recover conversation history", {
						threadId: threadChannel.id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

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

	/** Log a message to the message history store (fire-and-forget). */
	private logMessage(opts: {
		threadId: string;
		speaker: "user" | "randal";
		content: string;
		jobId?: string;
		pendingAction?: string;
	}): void {
		const mm = this.deps.messageManager;
		if (!mm) return;
		mm.add({
			threadId: opts.threadId,
			speaker: opts.speaker,
			channel: "discord",
			content: opts.content,
			timestamp: new Date().toISOString(),
			jobId: opts.jobId,
			pendingAction: opts.pendingAction,
		}).catch((err) => {
			this.logger.debug("Failed to log message", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
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

		// Log the inbound user message
		this.logMessage({
			threadId: conversationChannelId,
			speaker: "user",
			content: text,
			jobId,
		});

		// Show typing indicator while job is running
		const typingTarget = threadChannel ?? (msg.channel as unknown as SendableChannel);
		this.startTyping(jobId, typingTarget);
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

		// Log the inbound user message
		this.logMessage({
			threadId: channelId,
			speaker: "user",
			content: text,
			jobId,
		});

		// Show typing indicator while job is running
		const typingTarget = convo.threadChannel ?? (msg.channel as unknown as SendableChannel);
		this.startTyping(jobId, typingTarget);
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
	 * Start showing "is typing..." indicator for a job in a channel.
	 * Refreshes every 8 seconds (Discord typing expires after 10s).
	 */
	private startTyping(jobId: string, channel: SendableChannel): void {
		if (this.typingIntervals.has(jobId)) return;

		const sendTyping = () => {
			if ("sendTyping" in channel && typeof channel.sendTyping === "function") {
				(channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
			}
		};

		sendTyping();
		const interval = setInterval(sendTyping, 8000);
		this.typingIntervals.set(jobId, interval);
	}

	/**
	 * Stop showing "is typing..." indicator for a job.
	 */
	private stopTyping(jobId: string): void {
		const interval = this.typingIntervals.get(jobId);
		if (interval) {
			clearInterval(interval);
			this.typingIntervals.delete(jobId);
		}
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

	/**
	 * Pick a category emoji based on keywords in the text.
	 */
	private pickThreadEmoji(text: string): string {
		const lower = text.toLowerCase();
		const emojiMap: [string, string[]][] = [
			["🐛", ["fix", "bug", "error", "issue", "broken", "crash", "patch"]],
			["✨", ["add", "new", "create", "feature", "implement", "build"]],
			["🔧", ["update", "change", "modify", "adjust", "config", "refactor", "tweak"]],
			["📝", ["doc", "readme", "comment", "write", "draft", "note"]],
			["🧪", ["test", "spec", "coverage", "assert", "check"]],
			["🚀", ["deploy", "release", "ship", "launch", "publish", "push"]],
			["🔍", ["search", "find", "look", "investigate", "explore", "research", "analyze"]],
			["🎨", ["style", "css", "design", "ui", "layout", "theme", "color"]],
			["🗑️", ["delete", "remove", "clean", "drop", "prune"]],
			["📦", ["install", "package", "dependency", "npm", "pip", "upgrade"]],
			["🔐", ["auth", "security", "permission", "encrypt", "password", "token"]],
			["💬", ["chat", "discuss", "question", "help", "explain", "review"]],
		];

		for (const [emoji, keywords] of emojiMap) {
			if (keywords.some((kw) => lower.includes(kw))) {
				return emoji;
			}
		}
		return "🤖";
	}

	/**
	 * Format a short timestamp string like "3:45 PM".
	 */
	private formatUpdateTime(): string {
		return new Date().toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
		});
	}

	/**
	 * Generate a smart thread title from conversation context and job output.
	 * Format: "3:45 PM 🔧 Summary of work"
	 */
	private generateSmartThreadTitle(convo: Conversation, summary?: string): string {
		// Best source: job summary. Fallback: latest user message.
		let topic = summary?.replace(/\n/g, " ").replace(/\s+/g, " ").trim() || "";

		if (!topic) {
			const lastUserMsg = [...convo.history].reverse().find((m) => m.role === "user");
			topic = lastUserMsg?.content.replace(/\n/g, " ").replace(/\s+/g, " ").trim() || "Task";
		}

		// If topic is very long, take the first sentence
		const firstSentence = topic.match(/^[^.!?]+[.!?]?\s*/);
		if (firstSentence && topic.length > 60) {
			topic = firstSentence[0].trim();
		}

		const emoji = this.pickThreadEmoji(topic);
		const time = this.formatUpdateTime();
		const prefix = `${time} ${emoji} `;

		// Discord thread name max is 100 chars
		const maxTopicLen = 100 - prefix.length;
		if (topic.length > maxTopicLen) {
			topic = `${topic.slice(0, maxTopicLen - 3).replace(/\s+\S*$/, "")}...`;
		}

		return `${prefix}${topic}`;
	}

	/**
	 * Update the thread title to reflect conversation progress.
	 * Called on job completion to keep thread names meaningful.
	 */
	private async updateThreadTitle(jobId: string, event: RunnerEvent): Promise<void> {
		const channelId = this.jobToChannel.get(jobId);
		if (!channelId) return;

		const convo = this.conversations.get(channelId);
		if (!convo?.threadChannel) return; // Only update guild threads, not DMs

		const summary = event.data.summary || event.data.output;

		try {
			const newTitle = this.generateSmartThreadTitle(convo, summary);
			await convo.threadChannel.setName(newTitle);
			this.logger.debug("Updated thread title", { jobId, title: newTitle });
		} catch (err) {
			this.logger.debug("Failed to update thread title", {
				error: err instanceof Error ? err.message : String(err),
				jobId,
			});
		}
	}

	private onRunnerEvent(event: RunnerEvent): void {
		const terminal = ["job.complete", "job.failed", "job.stuck"];
		const intermediate = ["iteration.output", "job.plan_updated", "iteration.start"];

		if (!terminal.includes(event.type) && !intermediate.includes(event.type)) return;

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

		// If no cached channel found (e.g. after restart), fetch it async
		if (!target || !("send" in target)) {
			const fetchId = channelId ?? job.origin.replyTo;
			this.client.channels
				.fetch(fetchId)
				.then((fetched) => {
					if (fetched && "send" in fetched) {
						this.handleResolvedEvent(
							event,
							fetched as unknown as SendableChannel,
							convo,
							channelId,
						);
					} else {
						this.logger.warn("Could not resolve channel for event after fetch", {
							jobId: event.jobId,
							channelId: fetchId,
						});
					}
				})
				.catch((err) => {
					this.logger.warn("Failed to fetch channel for event routing", {
						jobId: event.jobId,
						channelId: fetchId,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			return;
		}

		const sendable = target as SendableChannel;
		this.handleResolvedEvent(event, sendable, convo, channelId);
	}

	/**
	 * Handle an event once we have a resolved sendable channel.
	 * Shared by the sync path (channel in cache) and async path (fetched after restart).
	 */
	private handleResolvedEvent(
		event: RunnerEvent,
		sendable: SendableChannel,
		convo: Conversation | undefined,
		channelId: string | undefined,
	): void {
		const intermediate = ["iteration.output", "job.plan_updated", "iteration.start"];

		// Handle intermediate events as edit-in-place progress messages
		if (intermediate.includes(event.type)) {
			this.handleProgressEvent(event, sendable);
			return;
		}

		// Terminal events
		const message = formatEvent(event);

		// Update conversation history with assistant response
		if (convo && event.type === "job.complete") {
			const response = event.data.output || event.data.summary || message;
			convo.history.push({ role: "assistant", content: response });
			convo.activeJobId = null;

			// Log the outbound response
			if (channelId) {
				this.logMessage({
					threadId: channelId,
					speaker: "randal",
					content: response,
					jobId: event.jobId,
				});
			}
		} else if (convo && event.type === "job.failed") {
			convo.activeJobId = null;

			// Log the failure
			if (channelId) {
				this.logMessage({
					threadId: channelId,
					speaker: "randal",
					content: message,
					jobId: event.jobId,
				});
			}
		}

		this.sendReply(sendable, message).catch((err: unknown) => {
			this.logger.warn("Failed to send Discord notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
			});
		});

		// Clean up on terminal events (but keep conversation alive)
		if (event.type === "job.complete" || event.type === "job.failed") {
			// Update thread title before cleaning up jobToChannel mapping
			this.updateThreadTitle(event.jobId, event).catch((err: unknown) => {
				this.logger.debug("Thread title update failed", {
					error: err instanceof Error ? err.message : String(err),
					jobId: event.jobId,
				});
			});
			this.stopTyping(event.jobId);
			this.jobToChannel.delete(event.jobId);
			this.finalizeProgressMessage(event);
		}
	}

	/**
	 * Edit the progress message to its final state and clean up tracking.
	 * Shows completion or failure status so it doesn't look stale.
	 */
	private finalizeProgressMessage(event: RunnerEvent): void {
		const state = this.progressState.get(event.jobId);
		if (!state?.message || typeof state.message.edit !== "function") {
			this.progressState.delete(event.jobId);
			return;
		}

		// Cancel any pending debounced edit
		if (state.pendingUpdate) {
			clearTimeout(state.pendingUpdate);
		}

		const status = event.type === "job.complete" ? "✅ Complete" : "❌ Failed";
		const parts: string[] = [status];

		// Preserve the plan in final state if it existed
		if (state.plan && state.plan.length > 0) {
			const lines = state.plan.map((t) => {
				const icon = t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : "⬜";
				return `${icon} ${t.task}`;
			});
			parts.push(lines.join("\n"));
		}

		const content = parts.join("\n");
		state.message.edit(content).catch(() => {});
		this.progressState.delete(event.jobId);
	}

	/**
	 * Handle intermediate progress events by maintaining a single edit-in-place
	 * status message per job. Creates the message on first event, edits it on subsequent ones.
	 */
	private async handleProgressEvent(event: RunnerEvent, channel: SendableChannel): Promise<void> {
		let state = this.progressState.get(event.jobId);
		if (!state) {
			state = {
				message: null,
				latestProgress: null,
				plan: null,
				iteration: event.data.iteration ?? 1,
				maxIterations: event.data.maxIterations ?? 1,
				lastEditAt: 0,
				pendingUpdate: null,
			};
			this.progressState.set(event.jobId, state);
		}

		// Update state based on event type
		switch (event.type) {
			case "iteration.output":
				state.latestProgress = event.data.outputLine ?? null;
				break;
			case "job.plan_updated":
				state.plan = (event.data.plan as Array<{ task: string; status: string }>) ?? null;
				break;
			case "iteration.start":
				state.iteration = event.data.iteration ?? state.iteration;
				state.maxIterations = event.data.maxIterations ?? state.maxIterations;
				// Only show iteration updates for iter 2+ (first is obvious)
				if ((event.data.iteration ?? 0) < 2) return;
				break;
		}

		// First event — send immediately (no debounce needed)
		if (!state.message) {
			const content = this.buildProgressContent(state);
			try {
				const sent = await channel.send(content);
				state.message = sent;
				state.lastEditAt = Date.now();
			} catch (err) {
				this.logger.debug("Failed to send progress message", {
					error: err instanceof Error ? err.message : String(err),
					jobId: event.jobId,
				});
			}
			return;
		}

		// Subsequent events — debounce edits to avoid Discord rate limits
		this.scheduleProgressEdit(event.jobId, state);
	}

	/**
	 * Debounce progress message edits. If enough time has elapsed since the last
	 * edit, fire immediately. Otherwise, schedule a deferred edit.
	 */
	private scheduleProgressEdit(
		jobId: string,
		state: NonNullable<ReturnType<typeof this.progressState.get>>,
	): void {
		if (state.pendingUpdate) {
			clearTimeout(state.pendingUpdate);
			state.pendingUpdate = null;
		}

		const elapsed = Date.now() - state.lastEditAt;
		const delay = Math.max(0, DiscordChannel.EDIT_DEBOUNCE_MS - elapsed);

		const doEdit = async () => {
			state.pendingUpdate = null;
			if (!state.message || typeof state.message.edit !== "function") return;
			const content = this.buildProgressContent(state);
			try {
				await state.message.edit(content);
				state.lastEditAt = Date.now();
			} catch (err) {
				this.logger.debug("Failed to edit progress message", {
					error: err instanceof Error ? err.message : String(err),
					jobId,
				});
			}
		};

		if (delay === 0) {
			doEdit();
		} else {
			state.pendingUpdate = setTimeout(doEdit, delay);
		}
	}

	/**
	 * Build the content for an edit-in-place progress status message.
	 */
	private buildProgressContent(state: {
		latestProgress: string | null;
		plan: Array<{ task: string; status: string }> | null;
		iteration: number;
		maxIterations: number;
	}): string {
		const parts: string[] = [];

		if (state.latestProgress) {
			parts.push(`💭 ${state.latestProgress}`);
		}

		if (state.plan && state.plan.length > 0) {
			const lines = state.plan.map((t) => {
				const icon =
					t.status === "completed"
						? "✅"
						: t.status === "in_progress"
							? "⏳"
							: t.status === "failed"
								? "❌"
								: "⬜";
				return `${icon} ${t.task}`;
			});
			parts.push(`📋 **Plan**\n${lines.join("\n")}`);
		}

		if (state.maxIterations > 1 && state.iteration > 1) {
			parts.push(`🔄 Iteration ${state.iteration}/${state.maxIterations}`);
		}

		return parts.join("\n\n") || "⏳ Working...";
	}

	/**
	 * Recover a job→channel mapping after gateway restart.
	 * Called by the gateway for each resumed job that originated from Discord.
	 * Pre-populates jobToChannel and conversations so that when the resumed
	 * job completes, the response routes back to the correct thread.
	 */
	async recoverJob(jobId: string, threadId: string): Promise<void> {
		this.jobToChannel.set(jobId, threadId);

		if (!this.conversations.has(threadId)) {
			// Try to fetch the thread channel from Discord
			let threadChannel: ThreadChannel | null = null;
			try {
				const channel = await this.client.channels.fetch(threadId);
				if (channel?.isThread()) {
					threadChannel = channel as ThreadChannel;
				}
			} catch {
				this.logger.debug("Could not fetch thread channel for recovery", { threadId });
			}

			// Load history from Meilisearch
			let history: Conversation["history"] = [];
			const mm = this.deps.messageManager;
			if (mm) {
				try {
					const msgs = await mm.thread(threadId);
					history = msgs.map((m) => ({
						role: m.speaker === "user" ? ("user" as const) : ("assistant" as const),
						content: m.content,
					}));
					this.logger.info("Recovered conversation for resumed job", {
						threadId,
						jobId,
						messageCount: history.length,
					});
				} catch (err) {
					this.logger.warn("Failed to load history for recovered job", {
						threadId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			this.conversations.set(threadId, {
				threadChannel,
				history,
				activeJobId: jobId,
			});
		} else {
			// Conversation already exists, just link the job
			const convo = this.conversations.get(threadId);
			if (convo) convo.activeJobId = jobId;
		}
	}

	stop(): void {
		for (const interval of this.typingIntervals.values()) {
			clearInterval(interval);
		}
		this.typingIntervals.clear();
		for (const state of this.progressState.values()) {
			if (state.pendingUpdate) clearTimeout(state.pendingUpdate);
		}
		this.progressState.clear();
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		this.client.destroy();
		this.logger.info("Discord channel stopped");
	}
}
