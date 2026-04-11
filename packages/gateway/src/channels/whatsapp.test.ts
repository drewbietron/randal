import { describe, expect, mock, test } from "bun:test";
import type { ChannelDeps } from "./channel.js";
import { WhatsAppChannel } from "./whatsapp.js";

// ── Helpers ─────────────────────────────────────────────────

function makeMockDeps(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
	return {
		config: { name: "test" } as ChannelDeps["config"],
		runner: {
			submit: mock(() => ({ jobId: "job-1", done: Promise.resolve() })),
			getJob: mock(() => null),
			getActiveJobs: mock(() => []),
			stop: mock(() => true),
		} as unknown as ChannelDeps["runner"],
		eventBus: {
			subscribe: mock(() => () => {}),
			emit: mock(() => {}),
			subscriberCount: 0,
		} as unknown as ChannelDeps["eventBus"],
		...overrides,
	};
}

function makeWhatsAppConfig(overrides: Record<string, unknown> = {}) {
	return {
		type: "whatsapp" as const,
		provider: "twilio",
		phoneNumber: "+15551234567",
		accountSid: "AC_FAKE",
		authToken: "fake-auth-token",
		allowFrom: [] as string[],
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────

describe("WhatsAppChannel", () => {
	test("adapter name is 'whatsapp'", () => {
		const config = makeWhatsAppConfig();
		const deps = makeMockDeps();
		const channel = new WhatsAppChannel(config as never, deps);
		expect(channel.name).toBe("whatsapp");
	});

	test("start/stop lifecycle", async () => {
		const unsubscribe = mock(() => {});
		const subscribe = mock(() => unsubscribe);
		const deps = makeMockDeps({
			eventBus: {
				subscribe,
				emit: mock(() => {}),
				subscriberCount: 0,
			} as unknown as ChannelDeps["eventBus"],
		});
		const config = makeWhatsAppConfig();
		const channel = new WhatsAppChannel(config as never, deps);

		await channel.start();
		expect(subscribe).toHaveBeenCalledTimes(1);

		channel.stop();
	});

	test("has send() method", () => {
		const config = makeWhatsAppConfig();
		const deps = makeMockDeps();
		const channel = new WhatsAppChannel(config as never, deps);
		expect(typeof channel.send).toBe("function");
	});

	test("phone number normalization", async () => {
		// The normalizePhone function strips "whatsapp:" prefix and non-digits
		// We test it through the handleIncoming behavior

		const submitMock = mock(() => ({ jobId: "job-wa-1", done: Promise.resolve() }));
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
		});
		const config = makeWhatsAppConfig({ allowFrom: ["+15559876543"] });
		const channel = new WhatsAppChannel(config as never, deps);

		// Test with "whatsapp:" prefix — should normalize and match
		const payload = {
			From: "whatsapp:+1 (555) 987-6543",
			To: "whatsapp:+15551234567",
			Body: "hello",
			MessageSid: "SM123",
		};

		await (
			channel as unknown as { handleIncoming: (payload: unknown) => Promise<void> }
		).handleIncoming(payload);

		// After normalization: +15559876543 should match allowFrom
		expect(submitMock).toHaveBeenCalledTimes(1);
	});

	test("allowFrom filter blocks unauthorized phone numbers", async () => {
		const deps = makeMockDeps();
		const config = makeWhatsAppConfig({ allowFrom: ["+15551111111"] });
		const channel = new WhatsAppChannel(config as never, deps);

		const payload = {
			From: "whatsapp:+15559999999",
			To: "whatsapp:+15551234567",
			Body: "hello",
			MessageSid: "SM456",
		};

		await (
			channel as unknown as { handleIncoming: (payload: unknown) => Promise<void> }
		).handleIncoming(payload);

		expect(deps.runner.submit).not.toHaveBeenCalled();
	});
});
