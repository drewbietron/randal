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

export class DiscordChannel implements ChannelAdapter {
	readonly name = "discord";
	private client: Client;
	private unsubscribe?: () => void;
	private logger = createLogger({ context: { component: "channel:discord" } });
	private jobThreads = new Map<string, ThreadChannel>();
	private threadToJob = new Map<string, string>();

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
		const isJobThread = msg.channel.isThread() && this.threadToJob.has(msg.channel.id);

		// allowFrom filter
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(msg.author.id)) return;
		} else if (!isDM && !isJobThread) {
			// No allowFrom + guild message + not a job thread: only respond if bot is mentioned
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

		// Route thread replies to the associated job
		if (isJobThread) {
			await this.handleThreadReply(msg, text);
			return;
		}

		const origin = {
			channel: "discord" as const,
			replyTo: msg.channel.id,
			from: msg.author.id,
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			const sentMessage = await msg.reply(response);

			// If a job was started, create a thread with a human-readable name
			const jobIdMatch = response.match(/Job `([a-f0-9]+)` started/);
			if (jobIdMatch && sentMessage && "startThread" in sentMessage) {
				try {
					const jobId = jobIdMatch[1];
					const job = this.deps.runner.getJob(jobId);
					const threadName = this.generateThreadName(job?.prompt ?? text);
					const thread = await (sentMessage as unknown as ThreadableMessage).startThread({
						name: threadName,
					});
					this.jobThreads.set(jobId, thread);
					this.threadToJob.set(thread.id, jobId);
				} catch {
					// DMs don't support threads — that's fine, replies go to the DM channel
				}
			}
		} catch (err) {
			this.logger.error("Discord message handling failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			try {
				await msg.reply("Something went wrong processing your request.");
			} catch {
				// Can't reply — channel may be inaccessible
			}
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
	 * Handle a reply within a job thread.
	 * Active jobs get context injected; completed jobs start a new run.
	 */
	private async handleThreadReply(msg: DiscordMessage, text: string): Promise<void> {
		const threadChannel = msg.channel as ThreadChannel;
		const jobId = this.threadToJob.get(threadChannel.id);
		if (!jobId) return;
		const activeJob = this.deps.runner.getJob(jobId);

		try {
			if (activeJob && (activeJob.status === "running" || activeJob.status === "queued")) {
				// Explicit commands target the thread's job
				const parsed = parseCommand(text);
				if (parsed?.command === "stop") {
					this.deps.runner.stop(jobId);
					await msg.reply("Stopping job.");
					return;
				}
				if (parsed?.command === "status") {
					const iter = activeJob.iterations.current;
					const max = activeJob.maxIterations;
					await msg.reply(`Running — iteration ${iter}/${max}`);
					return;
				}

				// Anything else is context for the running agent
				writeContext(activeJob.workdir, text);
				await msg.reply("Sent to agent.");
				return;
			}

			// Job is not active — treat as a new command in this thread
			const origin = {
				channel: "discord" as const,
				replyTo: threadChannel.id,
				from: msg.author.id,
			};

			const response = await handleCommand(text, this.deps, origin);
			await msg.reply(response);

			// If a new job started, update thread mapping so events route here
			const newJobIdMatch = response.match(/Job `([a-f0-9]+)` started/);
			if (newJobIdMatch) {
				const newJobId = newJobIdMatch[1];
				this.jobThreads.set(newJobId, threadChannel);
				this.threadToJob.set(threadChannel.id, newJobId);
			}
		} catch (err) {
			this.logger.error("Thread reply handling failed", {
				error: err instanceof Error ? err.message : String(err),
				jobId,
			});
			try {
				await msg.reply("Something went wrong.");
			} catch {
				// Can't reply
			}
		}
	}

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Look up the job to check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "discord") return;

		// Prefer thread if available, fall back to channel
		const thread = this.jobThreads.get(event.jobId);
		const fallbackChannel = this.client.channels.cache.get(job.origin.replyTo);
		const target = thread ?? fallbackChannel;
		if (!target || !("send" in target)) return;

		const sendable = target as SendableChannel;
		const message = formatEvent(event);
		this.sendReply(sendable, message).catch((err: unknown) => {
			this.logger.warn("Failed to send Discord notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
			});
		});

		// Clean up jobThreads but keep threadToJob for follow-up replies
		if (event.type === "job.complete" || event.type === "job.failed") {
			this.jobThreads.delete(event.jobId);
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
