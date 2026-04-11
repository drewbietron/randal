import type { RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import type { Hono } from "hono";
import type { ChannelAdapter, ChannelDeps } from "./channel.js";

const _logger = createLogger({ context: { component: "channel:factory" } });

type ChannelConfig = RandalConfig["gateway"]["channels"][number];

export interface ChannelCreateResult {
	adapter: ChannelAdapter;
	/** Optional Hono sub-app to mount before start() (e.g., WhatsApp/iMessage webhooks) */
	webhookRouter?: { path: string; router: Hono };
}

/**
 * Create a channel adapter from config. Returns the adapter and optional webhook router.
 * Throws if the channel type is unknown or if a required npm dependency is missing.
 */
export async function createChannel(
	channelConfig: ChannelConfig,
	deps: ChannelDeps,
): Promise<ChannelCreateResult> {
	switch (channelConfig.type) {
		case "discord": {
			const { DiscordChannel } = await import("./discord.js");
			return { adapter: new DiscordChannel(channelConfig, deps) };
		}
		case "imessage": {
			const { IMessageChannel } = await import("./imessage.js");
			const adapter = new IMessageChannel(channelConfig, deps);
			return {
				adapter,
				webhookRouter: { path: "/webhooks/imessage", router: adapter.getWebhookRouter() },
			};
		}
		case "telegram": {
			try {
				const { TelegramChannel } = await import("./telegram.js");
				return { adapter: new TelegramChannel(channelConfig, deps) };
			} catch (err) {
				throw new DependencyError("telegram", "telegraf", err);
			}
		}
		case "slack": {
			try {
				const { SlackChannel } = await import("./slack.js");
				return { adapter: new SlackChannel(channelConfig, deps) };
			} catch (err) {
				throw new DependencyError("slack", "@slack/bolt", err);
			}
		}
		case "email": {
			try {
				const { EmailChannel } = await import("./email.js");
				return { adapter: new EmailChannel(channelConfig, deps) };
			} catch (err) {
				throw new DependencyError("email", "imapflow and nodemailer", err);
			}
		}
		case "whatsapp": {
			// Validate Twilio credentials at startup
			if (channelConfig.provider === "twilio" || !channelConfig.provider) {
				if (!channelConfig.accountSid || !channelConfig.authToken || !channelConfig.phoneNumber) {
					throw new Error(
						'WhatsApp channel with provider "twilio" requires accountSid, authToken, and phoneNumber',
					);
				}
			}
			const { WhatsAppChannel } = await import("./whatsapp.js");
			const adapter = new WhatsAppChannel(channelConfig, deps);
			return {
				adapter,
				webhookRouter: { path: "/webhooks/whatsapp", router: adapter.getWebhookRouter() },
			};
		}
		case "signal": {
			const { SignalChannel } = await import("./signal.js");
			return { adapter: new SignalChannel(channelConfig, deps) };
		}
		case "voice": {
			const { VoiceChannel } = await import("./voice.js");
			return { adapter: new VoiceChannel(channelConfig, deps) };
		}
		case "http":
			// HTTP is handled separately via createHttpApp(), not as an adapter
			throw new Error("HTTP channel is not a startable adapter — it is the base server");
		default: {
			const exhaustive: never = channelConfig;
			throw new Error(`Unknown channel type: ${(exhaustive as { type: string }).type}`);
		}
	}
}

/**
 * Error thrown when a channel's npm dependency is not installed.
 */
export class DependencyError extends Error {
	constructor(
		public readonly channelType: string,
		public readonly packageName: string,
		cause: unknown,
	) {
		super(
			`Channel "${channelType}" requires "${packageName}" to be installed. ` +
				`Run: bun add ${packageName}`,
		);
		this.name = "DependencyError";
		this.cause = cause;
	}
}
