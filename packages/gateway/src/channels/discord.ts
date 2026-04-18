import { createLogger } from "@randal/core";
import type { Job, RandalConfig, RunnerEvent } from "@randal/core";
import { writeContext } from "@randal/runner";
import {
	Client,
	type Message as DiscordMessage,
	Events,
	GatewayIntentBits,
	type Interaction,
	MessageFlags,
	Partials,
	REST,
	Routes,
	type ThreadChannel,
} from "discord.js";
import { listJobs, loadJob } from "../jobs.js";
import { parseCommand } from "../router.js";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";
import {
	type DiscordServerConfig,
	SLASH_COMMANDS,
	type ThreadLifecycleState,
	buildCompletionButtons,
	buildContextModal,
	buildCustomCommand,
	buildCustomCommandPrompt,
	buildDashboardEmbed,
	buildDashboardRefreshButton,
	buildDisabledProgressButtons,
	buildFailureButtons,
	buildJobEmbed,
	buildMemoryModal,
	buildProgressButtons,
	buildThreadName,
	parseButtonId,
} from "./discord-components.js";
import { splitMessage } from "./utils.js";

/** Minimal sendable channel interface (avoids discord.js PartialGroupDMChannel issues) */
interface SendableChannel {
	send(
		content: string | { content?: string; embeds?: unknown[]; components?: unknown[] },
	): Promise<unknown>;
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
	// Map guild ID → server config for per-server commands/overrides
	private serverConfigs = new Map<string, DiscordServerConfig>();
	// Set of custom command names registered across all servers (for routing)
	private customCommandNames = new Set<string>();
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

		// Index server configs by guild ID
		for (const server of this.channelConfig.servers ?? []) {
			this.serverConfigs.set(server.guildId, server);
			for (const cmd of server.commands) {
				this.customCommandNames.add(cmd.name);
			}
		}
	}

	async start(): Promise<void> {
		// Register message handler
		this.client.on(Events.MessageCreate, (msg) => this.onMessage(msg));

		// Register interaction handler (buttons, slash commands, modals)
		this.client.on(Events.InteractionCreate, (interaction) => {
			this.onInteraction(interaction).catch((err) => {
				this.logger.warn("Interaction handler error", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		});

		// Log when ready, register slash commands, preload conversations
		this.client.once(Events.ClientReady, (c) => {
			this.logger.info("Discord bot connected", { tag: c.user.tag });

			// Register slash commands
			this.registerSlashCommands(c.user.id).catch((err) => {
				this.logger.warn("Failed to register slash commands", {
					error: err instanceof Error ? err.message : String(err),
				});
			});

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
				const threadName = buildThreadName({
					state: "started",
					topic: this.generateThreadName(text),
				});
				const startMsg = await msg.reply(`Starting: **${this.generateThreadName(text)}**`);
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
		const chunks = splitMessage(text, DISCORD_MAX_LENGTH);
		for (const chunk of chunks) {
			await channel.send(chunk);
		}
	}

	/**
	 * Send a message to a specific Discord channel/thread by ID.
	 * Implements ChannelAdapter.send() for the internal channel API.
	 */
	async send(target: string, message: string): Promise<void> {
		const channel = await this.client.channels.fetch(target);
		if (!channel || !("send" in channel)) {
			throw new Error(`Cannot send to Discord channel ${target}: not a text channel`);
		}
		await this.sendReply(channel as SendableChannel, message);
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
		// System-wide broadcast events — send to all guilds
		if (event.type === "system.update") {
			this.broadcastToGuilds(formatEvent(event));
			return;
		}

		const terminal = ["job.complete", "job.failed", "job.stuck"];
		const intermediate = ["iteration.output", "job.plan_updated", "iteration.start"];
		const brainEvents = ["brain.notification", "brain.alert"];

		if (
			!terminal.includes(event.type) &&
			!intermediate.includes(event.type) &&
			!brainEvents.includes(event.type)
		)
			return;

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

		// Handle brain-emitted events as standalone messages
		if (event.type === "brain.notification" || event.type === "brain.alert") {
			const brainMessage = formatEvent(event);
			this.sendReply(sendable, brainMessage).catch((err: unknown) => {
				this.logger.warn("Failed to send brain event to Discord", {
					error: err instanceof Error ? err.message : String(err),
					jobId: event.jobId,
					type: event.type,
				});
			});
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

		// Send terminal message with appropriate action buttons
		const terminalState: ThreadLifecycleState =
			event.type === "job.complete" ? "complete" : "failed";
		const buttons =
			event.type === "job.complete"
				? buildCompletionButtons(event.jobId)
				: buildFailureButtons(event.jobId);

		this.sendReplyWithComponents(sendable, message, [buttons]).catch((err: unknown) => {
			this.logger.warn("Failed to send Discord notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
			});
		});

		// Clean up on terminal events (but keep conversation alive)
		if (event.type === "job.complete" || event.type === "job.failed") {
			// Update thread title with lifecycle state
			this.updateThreadNameForState(event.jobId, terminalState, event);
			this.stopTyping(event.jobId);
			this.finalizeProgressMessage(event);
			// Delete jobToChannel after thread update has the ID
			this.jobToChannel.delete(event.jobId);
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
		state.message
			.edit({
				content,
				components: [buildDisabledProgressButtons(event.jobId)],
			})
			.catch(() => {});
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

		// Update thread name on iteration transitions (rate-limited by Discord ~2/10min)
		if (event.type === "iteration.start" && (event.data.iteration ?? 0) >= 2) {
			this.updateThreadNameForState(event.jobId, "running", event);
		}

		// First event — send immediately (no debounce needed)
		if (!state.message) {
			const content = this.buildProgressContent(state);
			try {
				const sent = await channel.send({
					content,
					components: [buildProgressButtons(event.jobId)],
				});
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
				await state.message.edit({ content, components: [buildProgressButtons(jobId)] });
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
	 * Send a reply with optional components (buttons, embeds), splitting long text.
	 * Components are only attached to the last chunk.
	 */
	private async sendReplyWithComponents(
		channel: SendableChannel,
		text: string,
		// biome-ignore lint: discord.js component types vary
		components: any[],
	): Promise<void> {
		const chunks = splitMessage(text, DISCORD_MAX_LENGTH);

		for (let i = 0; i < chunks.length; i++) {
			if (i === chunks.length - 1) {
				// Attach components to the last chunk only
				await channel.send({ content: chunks[i], components });
			} else {
				await channel.send(chunks[i]);
			}
		}
	}

	/**
	 * Register slash commands with Discord API.
	 * Global commands (universal) propagate to all servers (~1h first time).
	 * Per-server custom commands register as guild commands (instant).
	 */
	private async registerSlashCommands(applicationId: string): Promise<void> {
		const rest = new REST({ version: "10" }).setToken(this.channelConfig.token);
		const globalBody = SLASH_COMMANDS.map((cmd) => cmd.toJSON());

		const guildId = this.channelConfig.guildId;
		if (guildId) {
			// Legacy single-guild mode: register universal commands to one guild
			await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: globalBody });
			this.logger.info("Registered guild slash commands", { guildId, count: globalBody.length });
		} else {
			// Register universal commands globally
			await rest.put(Routes.applicationCommands(applicationId), { body: globalBody });
			this.logger.info("Registered global slash commands", { count: globalBody.length });
		}

		// Register per-server custom commands as guild commands (instant)
		for (const [serverGuildId, serverConfig] of this.serverConfigs) {
			if (serverConfig.commands.length === 0) continue;

			const customBody = serverConfig.commands.map((cmd) => buildCustomCommand(cmd).toJSON());

			// Merge with global commands if this guild doesn't already have them via guildId
			const body = serverGuildId === guildId ? [...globalBody, ...customBody] : customBody;

			// For guilds that got global commands above, we only need to add custom ones.
			// But Discord's PUT replaces all guild commands, so if this guild was the guildId target,
			// we re-register global + custom together. Otherwise, just register the custom ones
			// (global commands already available via global registration).
			if (serverGuildId === guildId) {
				await rest.put(Routes.applicationGuildCommands(applicationId, serverGuildId), { body });
			} else {
				await rest.put(Routes.applicationGuildCommands(applicationId, serverGuildId), {
					body: customBody,
				});
			}

			this.logger.info("Registered server-specific slash commands", {
				guildId: serverGuildId,
				customCount: customBody.length,
			});
		}
	}

	/**
	 * Handle Discord interactions: slash commands, buttons, modals, select menus.
	 */
	private async onInteraction(interaction: Interaction): Promise<void> {
		if (interaction.isChatInputCommand()) {
			await this.handleSlashCommand(interaction);
		} else if (interaction.isButton()) {
			await this.handleButtonInteraction(interaction);
		} else if (interaction.isModalSubmit()) {
			await this.handleModalSubmit(interaction);
		} else if (interaction.isStringSelectMenu()) {
			await this.handleSelectMenu(interaction);
		}
	}

	/**
	 * Handle slash command interactions.
	 */
	// biome-ignore lint: discord.js interaction types are complex
	private async handleSlashCommand(interaction: any): Promise<void> {
		const origin = {
			channel: "discord" as const,
			replyTo: interaction.channelId,
			from: interaction.user.id,
		};

		switch (interaction.commandName) {
			case "run": {
				const prompt = interaction.options.getString("prompt");
				if (!prompt) {
					await interaction.reply({ content: "Prompt is required", flags: MessageFlags.Ephemeral });
					return;
				}
				const response = await handleCommand(`run: ${prompt}`, this.deps, origin);
				await interaction.reply(response);

				// Also start conversation thread if in a guild
				if (interaction.guild && interaction.channel) {
					const { jobId } = this.deps.runner.getActiveJobs().slice(-1)[0]
						? { jobId: this.deps.runner.getActiveJobs().slice(-1)[0].id }
						: { jobId: null };
					if (jobId) {
						this.jobToChannel.set(jobId, interaction.channelId);
					}
				}
				break;
			}
			case "status": {
				const jobArg = interaction.options.getString("job");
				const response = await handleCommand(
					jobArg ? `status: ${jobArg}` : "status",
					this.deps,
					origin,
				);
				// If a specific job ID was given, show a rich embed
				if (jobArg) {
					const job = this.deps.runner.getJob(jobArg) ?? loadJob(jobArg);
					if (job) {
						const embed = buildJobEmbed(job);
						await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
						return;
					}
				}
				await interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
				break;
			}
			case "stop": {
				const jobArg = interaction.options.getString("job");
				const response = await handleCommand(
					jobArg ? `stop: ${jobArg}` : "stop",
					this.deps,
					origin,
				);
				await interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
				break;
			}
			case "resume": {
				const jobArg = interaction.options.getString("job");
				if (!jobArg) {
					await interaction.reply({ content: "Job ID is required", flags: MessageFlags.Ephemeral });
					return;
				}
				const response = await handleCommand(`resume: ${jobArg}`, this.deps, origin);
				await interaction.reply(response);
				break;
			}
			case "jobs": {
				await this.handleJobsSlashCommand(interaction);
				break;
			}
			case "memory": {
				const subcommand = interaction.options.getSubcommand();
				if (subcommand === "search") {
					const query = interaction.options.getString("query");
					const response = await handleCommand(`memory: ${query}`, this.deps, origin);
					await interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
				} else if (subcommand === "add") {
					await interaction.showModal(buildMemoryModal());
				}
				break;
			}
			case "dashboard": {
				await this.handleDashboardCommand(interaction);
				break;
			}
			default: {
				// Check if this is a server-specific custom command
				if (this.customCommandNames.has(interaction.commandName)) {
					await this.handleCustomSlashCommand(interaction);
				} else {
					await interaction.reply({
						content: `Unknown command: ${interaction.commandName}`,
						flags: MessageFlags.Ephemeral,
					});
				}
				break;
			}
		}
	}

	/**
	 * Handle a server-specific custom slash command.
	 * Resolves the guild's server config, builds a prompt from the command + options,
	 * and submits a job with any agent/model overrides from the server config.
	 */
	// biome-ignore lint: discord.js interaction types are complex
	private async handleCustomSlashCommand(interaction: any): Promise<void> {
		const guildId = interaction.guildId;
		const serverConfig = guildId ? this.serverConfigs.get(guildId) : undefined;

		if (!serverConfig) {
			await interaction.reply({
				content: `Command \`/${interaction.commandName}\` is not configured for this server`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const cmdConfig = serverConfig.commands.find((c) => c.name === interaction.commandName);
		if (!cmdConfig) {
			await interaction.reply({
				content: `Command \`/${interaction.commandName}\` not found in server config`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Collect option values
		const options: Array<{ name: string; value: unknown }> = [];
		for (const opt of cmdConfig.options) {
			const value = interaction.options.get(opt.name)?.value;
			if (value !== undefined && value !== null) {
				options.push({ name: opt.name, value });
			}
		}

		// Build prompt from command + options + server instructions
		const prompt = buildCustomCommandPrompt(
			interaction.commandName,
			options,
			serverConfig.instructions,
		);

		const origin = {
			channel: "discord" as const,
			replyTo: interaction.channelId,
			from: interaction.user.id,
		};

		// Submit job with server-specific overrides
		const { jobId } = this.deps.runner.submit({
			prompt,
			origin,
			...(serverConfig.agent && { agent: serverConfig.agent }),
			...(serverConfig.model && { model: serverConfig.model }),
		});
		this.jobToChannel.set(jobId, interaction.channelId);

		const optSummary =
			options.length > 0 ? ` (${options.map((o) => `${o.name}=${o.value}`).join(", ")})` : "";
		await interaction.reply(
			`Running \`/${interaction.commandName}\`${optSummary} → Job \`${jobId}\``,
		);
	}

	/**
	 * Handle button interactions.
	 */
	// biome-ignore lint: discord.js interaction types are complex
	private async handleButtonInteraction(interaction: any): Promise<void> {
		const parsed = parseButtonId(interaction.customId);
		if (!parsed) return;

		const { action, jobId } = parsed;

		switch (action) {
			case "stop": {
				if (!jobId) break;
				const stopped = this.deps.runner.stop(jobId);
				await interaction.reply({
					content: stopped
						? `Job \`${jobId}\` stopped`
						: `Job \`${jobId}\` not found or not running`,
					flags: MessageFlags.Ephemeral,
				});
				break;
			}
			case "context": {
				if (!jobId) break;
				await interaction.showModal(buildContextModal(jobId));
				break;
			}
			case "details": {
				if (!jobId) break;
				const job = this.deps.runner.getJob(jobId) ?? loadJob(jobId);
				if (!job) {
					await interaction.reply({
						content: `Job \`${jobId}\` not found`,
						flags: MessageFlags.Ephemeral,
					});
					break;
				}
				const embed = buildJobEmbed(job);
				await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
				break;
			}
			case "retry": {
				if (!jobId) break;
				const oldJob = this.deps.runner.getJob(jobId) ?? loadJob(jobId);
				if (!oldJob) {
					await interaction.reply({
						content: `Job \`${jobId}\` not found`,
						flags: MessageFlags.Ephemeral,
					});
					break;
				}
				const origin = {
					channel: "discord" as const,
					replyTo: interaction.channelId,
					from: interaction.user.id,
				};
				const { jobId: newId } = this.deps.runner.submit({ prompt: oldJob.prompt, origin });
				this.jobToChannel.set(newId, interaction.channelId);

				// Link to conversation if exists
				const convo = this.conversations.get(interaction.channelId);
				if (convo) convo.activeJobId = newId;

				await interaction.reply(`Retrying as job \`${newId}\``);
				break;
			}
			case "resume": {
				if (!jobId) break;
				const origin = {
					channel: "discord" as const,
					replyTo: interaction.channelId,
					from: interaction.user.id,
				};
				const response = await handleCommand(`resume: ${jobId}`, this.deps, origin);
				await interaction.reply(response);
				break;
			}
			case "save_memory": {
				if (!jobId) break;
				const job = this.deps.runner.getJob(jobId) ?? loadJob(jobId);
				const defaultText = job
					? (job.iterations.history.slice(-1)[0]?.summary || job.prompt).slice(0, 4000)
					: "";
				await interaction.showModal(buildMemoryModal(defaultText));
				break;
			}
			case "dashboard_refresh": {
				await this.handleDashboardCommand(interaction);
				break;
			}
		}
	}

	/**
	 * Handle modal submissions (context injection, memory add).
	 */
	// biome-ignore lint: discord.js interaction types are complex
	private async handleModalSubmit(interaction: any): Promise<void> {
		const parsed = parseButtonId(interaction.customId);
		if (!parsed) return;

		const { action, jobId } = parsed;

		switch (action) {
			case "modal_context": {
				if (!jobId) break;
				const text = interaction.fields.getTextInputValue("context_text");
				const job = this.deps.runner.getJob(jobId);
				if (!job || (job.status !== "running" && job.status !== "queued")) {
					await interaction.reply({
						content: `Job \`${jobId}\` is not running`,
						flags: MessageFlags.Ephemeral,
					});
					break;
				}
				writeContext(job.workdir, text);
				await interaction.reply({
					content: `Context injected into job \`${jobId}\``,
					flags: MessageFlags.Ephemeral,
				});
				break;
			}
			case "modal_memory": {
				const text = interaction.fields.getTextInputValue("memory_text");
				const category = interaction.fields.getTextInputValue("memory_category");
				if (!this.deps.memoryManager) {
					await interaction.reply({
						content: "Memory not available",
						flags: MessageFlags.Ephemeral,
					});
					break;
				}
				try {
					await this.deps.memoryManager.add({
						content: text,
						category: category as "fact",
						source: "human",
					});
					await interaction.reply({
						content: `Saved to memory (${category})`,
						flags: MessageFlags.Ephemeral,
					});
				} catch {
					await interaction.reply({
						content: "Failed to save to memory",
						flags: MessageFlags.Ephemeral,
					});
				}
				break;
			}
		}
	}

	/**
	 * Handle string select menu interactions.
	 */
	// biome-ignore lint: discord.js interaction types are complex
	private async handleSelectMenu(interaction: any): Promise<void> {
		const parsed = parseButtonId(interaction.customId);
		if (!parsed) return;

		const selectedJobId = interaction.values?.[0];
		if (!selectedJobId) return;

		switch (parsed.action) {
			case "select_details": {
				const job = this.deps.runner.getJob(selectedJobId) ?? loadJob(selectedJobId);
				if (job) {
					await interaction.reply({ embeds: [buildJobEmbed(job)], flags: MessageFlags.Ephemeral });
				} else {
					await interaction.reply({
						content: `Job \`${selectedJobId}\` not found`,
						flags: MessageFlags.Ephemeral,
					});
				}
				break;
			}
			case "select_stop": {
				const stopped = this.deps.runner.stop(selectedJobId);
				await interaction.reply({
					content: stopped ? `Job \`${selectedJobId}\` stopped` : "Not running",
					flags: MessageFlags.Ephemeral,
				});
				break;
			}
			case "select_resume": {
				const origin = {
					channel: "discord" as const,
					replyTo: interaction.channelId,
					from: interaction.user.id,
				};
				const response = await handleCommand(`resume: ${selectedJobId}`, this.deps, origin);
				await interaction.reply(response);
				break;
			}
		}
	}

	/**
	 * Handle /jobs slash command with rich embeds.
	 */
	// biome-ignore lint: discord.js interaction types are complex
	private async handleJobsSlashCommand(interaction: any): Promise<void> {
		const active = this.deps.runner.getActiveJobs();
		const disk = listJobs();
		const activeIds = new Set(active.map((j) => j.id));
		const merged = [...active, ...disk.filter((j) => !activeIds.has(j.id))].slice(0, 10);

		if (merged.length === 0) {
			await interaction.reply({ content: "No jobs found", flags: MessageFlags.Ephemeral });
			return;
		}

		const lines = merged.map((j) => {
			const emoji =
				j.status === "running"
					? "🔄"
					: j.status === "complete"
						? "✅"
						: j.status === "failed"
							? "❌"
							: j.status === "stopped"
								? "⏸️"
								: "⏳";
			const dur = j.duration ? ` (${j.duration}s)` : "";
			return `${emoji} \`${j.id}\` ${j.status}${dur} — ${j.prompt.slice(0, 60)}`;
		});

		await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
	}

	/**
	 * Handle /dashboard command — show system overview with rich embed.
	 */
	// biome-ignore lint: discord.js interaction types are complex
	private async handleDashboardCommand(interaction: any): Promise<void> {
		const activeJobs = this.deps.runner.getActiveJobs() as Job[];
		const allJobs = listJobs();
		const recentJobs = allJobs
			.filter((j) => j.status !== "running" && j.status !== "queued")
			.slice(0, 5);

		let memoryCount: number | undefined;
		if (this.deps.memoryManager) {
			try {
				const results = await this.deps.memoryManager.search("*", 0);
				memoryCount = results.length;
			} catch {
				// Non-critical
			}
		}

		const embed = buildDashboardEmbed({
			activeJobs,
			recentJobs,
			memoryCount,
		});
		const refreshRow = buildDashboardRefreshButton();

		if (interaction.replied || interaction.deferred) {
			await interaction.editReply({ embeds: [embed], components: [refreshRow] });
		} else {
			await interaction.reply({ embeds: [embed], components: [refreshRow] });
		}
	}

	/**
	 * Update thread name to reflect job lifecycle state.
	 * Rate-limited by Discord (~2 name changes per 10 minutes).
	 */
	private updateThreadNameForState(
		jobId: string,
		state: ThreadLifecycleState,
		event: RunnerEvent,
	): void {
		const channelId = this.jobToChannel.get(jobId);
		if (!channelId) return;

		const convo = this.conversations.get(channelId);
		if (!convo?.threadChannel) return;

		const lastUserMsg = [...convo.history].reverse().find((m) => m.role === "user");
		let topic = event.data.summary || event.data.output || lastUserMsg?.content || "Task";
		// Take first sentence if long
		const firstSentence = topic.match(/^[^.!?]+[.!?]?\s*/);
		if (firstSentence && topic.length > 60) {
			topic = firstSentence[0].trim();
		}

		const name = buildThreadName({
			state,
			topic,
			iteration: event.data.iteration,
			maxIterations: event.data.maxIterations,
		});

		convo.threadChannel.setName(name).catch((err) => {
			this.logger.debug("Failed to update thread name", {
				error: err instanceof Error ? err.message : String(err),
				jobId,
			});
		});
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

	/** Get server-specific config for a guild. Returns undefined if no server config exists. */
	getServerConfig(guildId: string): DiscordServerConfig | undefined {
		return this.serverConfigs.get(guildId);
	}

	/** Get all registered custom command names across all servers. */
	getCustomCommandNames(): ReadonlySet<string> {
		return this.customCommandNames;
	}

	/**
	 * Broadcast a message to all guilds the bot is in.
	 * Sends to the system channel or first writable text channel per guild.
	 * Fire-and-forget — failures don't block other guilds.
	 */
	private broadcastToGuilds(message: string): void {
		for (const guild of this.client.guilds.cache.values()) {
			const me = guild.members.me;
			if (!me) continue;

			// Prefer system channel, fall back to first text channel the bot can send to
			const target =
				guild.systemChannel ??
				guild.channels.cache.find(
					(ch) => ch.isTextBased() && !ch.isThread() && ch.permissionsFor(me)?.has("SendMessages"),
				);
			if (target && "send" in target) {
				(target as SendableChannel).send(message).catch((err) => {
					this.logger.warn("Failed to broadcast to guild", {
						guildId: guild.id,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
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
