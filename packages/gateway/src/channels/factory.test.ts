import { describe, expect, mock, test } from "bun:test";
import type { ChannelDeps } from "./channel.js";
import { DependencyError, createChannel } from "./factory.js";

// ── Helpers ─────────────────────────────────────────────────

function makeMockDeps(): ChannelDeps {
	return {
		config: { name: "test" } as ChannelDeps["config"],
		runner: {
			submit: mock(() => ({ jobId: "j-1", done: Promise.resolve() })),
			getJob: mock(() => null),
			getActiveJobs: mock(() => []),
			stop: mock(() => true),
		} as unknown as ChannelDeps["runner"],
		eventBus: {
			subscribe: mock(() => () => {}),
			emit: mock(() => {}),
			subscriberCount: 0,
		} as unknown as ChannelDeps["eventBus"],
	};
}

// ── Tests ───────────────────────────────────────────────────

describe("createChannel", () => {
	test("creates TelegramChannel for type=telegram", async () => {
		const deps = makeMockDeps();
		const config = { type: "telegram" as const, token: "fake" };
		const result = await createChannel(config as never, deps);
		expect(result.adapter.name).toBe("telegram");
		expect(result.webhookRouter).toBeUndefined();
	});

	test("creates SlackChannel for type=slack", async () => {
		const deps = makeMockDeps();
		const config = {
			type: "slack" as const,
			botToken: "xoxb-fake",
			appToken: "xapp-fake",
		};
		const result = await createChannel(config as never, deps);
		expect(result.adapter.name).toBe("slack");
		expect(result.webhookRouter).toBeUndefined();
	});

	test("creates WhatsAppChannel with webhook router", async () => {
		const deps = makeMockDeps();
		const config = {
			type: "whatsapp" as const,
			provider: "twilio" as const,
			accountSid: "AC123",
			authToken: "tok",
			phoneNumber: "+1234567890",
		};
		const result = await createChannel(config as never, deps);
		expect(result.adapter.name).toBe("whatsapp");
		expect(result.webhookRouter).toBeDefined();
		expect(result.webhookRouter?.path).toBe("/webhooks/whatsapp");
	});

	test("creates SignalChannel for type=signal", async () => {
		const deps = makeMockDeps();
		const config = {
			type: "signal" as const,
			phoneNumber: "+1234567890",
			signalCliBin: "signal-cli",
		};
		const result = await createChannel(config as never, deps);
		expect(result.adapter.name).toBe("signal");
		expect(result.webhookRouter).toBeUndefined();
	});

	test("creates EmailChannel for type=email", async () => {
		const deps = makeMockDeps();
		const config = {
			type: "email" as const,
			imap: { host: "imap.test", port: 993, user: "u", password: "p", tls: true },
			smtp: { host: "smtp.test", port: 587, user: "u", password: "p", secure: false },
		};
		const result = await createChannel(config as never, deps);
		expect(result.adapter.name).toBe("email");
		expect(result.webhookRouter).toBeUndefined();
	});

	test("creates VoiceChannel for type=voice", async () => {
		const deps = makeMockDeps();
		const config = { type: "voice" as const };
		const result = await createChannel(config as never, deps);
		expect(result.adapter.name).toBe("voice");
		expect(result.webhookRouter).toBeUndefined();
	});

	test("throws for http type", async () => {
		const deps = makeMockDeps();
		const config = { type: "http" as const, port: 7600 };
		await expect(createChannel(config as never, deps)).rejects.toThrow("HTTP channel");
	});

	test("WhatsApp requires Twilio credentials", async () => {
		const deps = makeMockDeps();
		const config = {
			type: "whatsapp" as const,
			provider: "twilio" as const,
			// Missing accountSid, authToken, phoneNumber
		};
		await expect(createChannel(config as never, deps)).rejects.toThrow("accountSid");
	});

	test("WhatsApp default provider (twilio) requires credentials", async () => {
		const deps = makeMockDeps();
		const config = {
			type: "whatsapp" as const,
			// provider defaults to twilio when not specified
		};
		await expect(createChannel(config as never, deps)).rejects.toThrow("accountSid");
	});

	test("DependencyError has correct properties", () => {
		const err = new DependencyError("telegram", "telegraf", new Error("not found"));
		expect(err.channelType).toBe("telegram");
		expect(err.packageName).toBe("telegraf");
		expect(err.message).toContain("telegraf");
		expect(err.message).toContain("bun add");
		expect(err.name).toBe("DependencyError");
		expect(err.cause).toBeInstanceOf(Error);
	});
});
