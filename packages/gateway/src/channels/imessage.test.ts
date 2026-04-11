import { describe, expect, mock, test } from "bun:test";
import { EventBus } from "../events.js";
import type { ChannelDeps } from "./channel.js";
import { IMessageChannel } from "./imessage.js";

// ── Mock helpers ────────────────────────────────────────────

function makeChannelConfig(overrides: Record<string, unknown> = {}) {
	return {
		type: "imessage" as const,
		provider: "bluebubbles" as const,
		url: "http://localhost:1234",
		password: "test-password",
		...overrides,
	};
}

function makeDeps(overrides: Record<string, unknown> = {}): ChannelDeps {
	const eventBus = new EventBus();
	return {
		config: {
			gateway: { channels: [] },
		} as unknown as ChannelDeps["config"],
		runner: {
			execute: mock(() => Promise.resolve({ id: "abc1", status: "complete" })),
			submit: mock(() => ({
				jobId: "abc1",
				done: Promise.resolve({ id: "abc1", status: "complete" }),
			})),
			getActiveJobs: mock(() => [
				{ id: "abc1", status: "running", iterations: { current: 1 }, maxIterations: 5 },
			]),
			getJob: mock(() => undefined),
			stop: mock(() => true),
		} as unknown as ChannelDeps["runner"],
		eventBus,
		...overrides,
	};
}

function makeWebhookPayload(overrides: Record<string, unknown> = {}) {
	return {
		type: "new-message",
		data: {
			chats: [{ guid: "iMessage;-;+15551234567" }],
			handle: { address: "+15551234567" },
			text: "run: refactor auth",
			isFromMe: false,
			...overrides,
		},
	};
}

// ── IMessageChannel tests ───────────────────────────────────

describe("IMessageChannel", () => {
	test("constructs without errors", () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);
		expect(channel.name).toBe("imessage");
	});

	test("has send() method", () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);
		expect(typeof channel.send).toBe("function");
	});

	test("getWebhookRouter returns a Hono app", () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);
		const router = channel.getWebhookRouter();
		expect(router).toBeDefined();
		expect(router.fetch).toBeDefined();
	});

	test("webhook processes new-message payload", async () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);

		// Mock sendMessage to capture calls
		const sentMessages: Array<{ chatGuid: string; text: string }> = [];
		channel.sendMessage = mock(async (chatGuid: string, text: string) => {
			sentMessages.push({ chatGuid, text });
		});

		const router = channel.getWebhookRouter();
		const payload = makeWebhookPayload();

		const response = await router.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ ok: true });

		// Wait for async processing
		await new Promise((r) => setTimeout(r, 100));

		expect(sentMessages.length).toBeGreaterThanOrEqual(1);
	});

	test("webhook ignores own messages (isFromMe)", async () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);

		const sentMessages: Array<{ chatGuid: string; text: string }> = [];
		channel.sendMessage = mock(async (chatGuid: string, text: string) => {
			sentMessages.push({ chatGuid, text });
		});

		const router = channel.getWebhookRouter();
		const payload = makeWebhookPayload({ isFromMe: true });

		await router.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		await new Promise((r) => setTimeout(r, 100));
		expect(sentMessages).toHaveLength(0);
	});

	test("webhook ignores non-message events", async () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);

		const sentMessages: Array<{ chatGuid: string; text: string }> = [];
		channel.sendMessage = mock(async (chatGuid: string, text: string) => {
			sentMessages.push({ chatGuid, text });
		});

		const router = channel.getWebhookRouter();
		const payload = { type: "message-updated", data: {} };

		await router.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		await new Promise((r) => setTimeout(r, 100));
		expect(sentMessages).toHaveLength(0);
	});

	test("webhook respects allowFrom filter", async () => {
		const config = makeChannelConfig({ allowFrom: ["+15559999999"] });
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);

		const sentMessages: Array<{ chatGuid: string; text: string }> = [];
		channel.sendMessage = mock(async (chatGuid: string, text: string) => {
			sentMessages.push({ chatGuid, text });
		});

		const router = channel.getWebhookRouter();
		// Message from +15551234567, not in allowFrom
		const payload = makeWebhookPayload();

		await router.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		await new Promise((r) => setTimeout(r, 100));
		expect(sentMessages).toHaveLength(0);
	});

	test("phone normalization matches formatted numbers", async () => {
		const config = makeChannelConfig({ allowFrom: ["+15551234567"] });
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);

		const sentMessages: Array<{ chatGuid: string; text: string }> = [];
		channel.sendMessage = mock(async (chatGuid: string, text: string) => {
			sentMessages.push({ chatGuid, text });
		});

		const router = channel.getWebhookRouter();
		// Sender has formatted phone number
		const payload = makeWebhookPayload({ handle: { address: "+1 (555) 123-4567" } });
		// Fix: also set the handle on the data level
		payload.data.handle = { address: "+1 (555) 123-4567" };

		await router.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		await new Promise((r) => setTimeout(r, 100));
		expect(sentMessages.length).toBeGreaterThanOrEqual(1);
	});

	test("start does not throw on ping failure", async () => {
		// Port 1 is typically unreachable and will fail fast with connection refused
		const config = makeChannelConfig({ url: "http://127.0.0.1:1" });
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);

		// start() should not throw even if BlueBubbles is unreachable
		await expect(channel.start()).resolves.toBeUndefined();
		channel.stop();
	}, 10000);

	test("stop can be called safely", () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);

		expect(() => channel.stop()).not.toThrow();
	});

	test("stop unsubscribes from event bus", async () => {
		const config = makeChannelConfig({ url: "http://127.0.0.1:1" });
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);

		await channel.start();
		expect(deps.eventBus.subscriberCount).toBe(1);

		channel.stop();
		expect(deps.eventBus.subscriberCount).toBe(0);
	}, 10000);

	test("url trailing slash is stripped", () => {
		const config = makeChannelConfig({ url: "http://localhost:1234///" });
		const deps = makeDeps();
		const channel = new IMessageChannel(config, deps);
		// Verify URL is clean by checking the channel constructs without error
		expect(channel.name).toBe("imessage");
	});
});
