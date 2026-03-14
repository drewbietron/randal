import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import {
	Client,
	type Message as DiscordMessage,
	Events,
	GatewayIntentBits,
	Partials,
	type TextBasedChannel,
} from "discord.js";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

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
		await this.client.login(this.channelConfig.token);

		// Subscribe to EventBus for outbound notifications
		this.unsubscribe = this.deps.eventBus.subscribe((event) => this.onRunnerEvent(event));
	}

	private async onMessage(msg: DiscordMessage): Promise<void> {
		// Ignore bot messages
		if (msg.author.bot) return;

		const isDM = !msg.guild;
		const allowFrom = this.channelConfig.allowFrom;

		// allowFrom filter
		if (allowFrom && allowFrom.length > 0) {
			if (!allowFrom.includes(msg.author.id)) return;
		} else if (!isDM) {
			// No allowFrom set + guild message: only respond if bot is mentioned
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

		const origin = {
			channel: "discord" as const,
			replyTo: msg.channel.id,
			from: msg.author.id,
		};

		try {
			const response = await handleCommand(text, this.deps, origin);
			await this.sendReply(msg.channel as TextBasedChannel, response);
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
	async sendReply(channel: TextBasedChannel, text: string): Promise<void> {
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

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Look up the job to check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "discord") return;

		const channel = this.client.channels.cache.get(job.origin.replyTo) as
			| TextBasedChannel
			| undefined;
		if (!channel) return;

		const message = formatEvent(event);
		channel.send(message).catch((err) => {
			this.logger.warn("Failed to send Discord notification", {
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
		this.client.destroy();
		this.logger.info("Discord channel stopped");
	}
}
