import { createHmac } from "node:crypto";
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

// ── Twilio webhook signature validation tests ──────────────

/**
 * Compute a valid Twilio signature for testing.
 * Algorithm: HMAC-SHA1(authToken, url + sorted key-value pairs) → base64
 */
function computeTwilioSignature(
	authToken: string,
	url: string,
	params: Record<string, string>,
): string {
	const sortedKeys = Object.keys(params).sort();
	let data = url;
	for (const key of sortedKeys) {
		data += key + params[key];
	}
	return createHmac("sha1", authToken).update(data).digest("base64");
}

describe("WhatsApp webhook signature validation", () => {
	const AUTH_TOKEN = "test-auth-token-32chars-abcdef12";
	// The webhookUrl for signature computation is the full external URL,
	// but the Hono sub-router only handles "/" (it's mounted at /webhooks/whatsapp externally)
	const WEBHOOK_URL = "https://example.com/webhooks/whatsapp";
	const ROUTER_URL = "https://example.com/";

	function makeFormBody(params: Record<string, string>): string {
		return Object.entries(params)
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join("&");
	}

	test("valid Twilio signature returns TwiML response", async () => {
		const deps = makeMockDeps();
		const config = makeWhatsAppConfig({ authToken: AUTH_TOKEN, webhookUrl: WEBHOOK_URL });
		const channel = new WhatsAppChannel(config as never, deps);
		const router = channel.getWebhookRouter();

		const params = {
			From: "whatsapp:+15559876543",
			To: "whatsapp:+15551234567",
			Body: "hello world",
			MessageSid: "SM_TEST_123",
		};

		const signature = computeTwilioSignature(AUTH_TOKEN, WEBHOOK_URL, params);

		const req = new Request(ROUTER_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"X-Twilio-Signature": signature,
				"Host": "example.com",
			},
			body: makeFormBody(params),
		});

		const res = await router.fetch(req);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("<Response>");
	});

	test("missing X-Twilio-Signature header returns 401", async () => {
		const deps = makeMockDeps();
		const config = makeWhatsAppConfig({ authToken: AUTH_TOKEN, webhookUrl: WEBHOOK_URL });
		const channel = new WhatsAppChannel(config as never, deps);
		const router = channel.getWebhookRouter();

		const params = {
			From: "whatsapp:+15559876543",
			To: "whatsapp:+15551234567",
			Body: "hello",
			MessageSid: "SM_TEST_456",
		};

		const req = new Request(ROUTER_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Host": "example.com",
				// No X-Twilio-Signature header
			},
			body: makeFormBody(params),
		});

		const res = await router.fetch(req);
		expect(res.status).toBe(401);
	});

	test("invalid/forged X-Twilio-Signature returns 403", async () => {
		const deps = makeMockDeps();
		const config = makeWhatsAppConfig({ authToken: AUTH_TOKEN, webhookUrl: WEBHOOK_URL });
		const channel = new WhatsAppChannel(config as never, deps);
		const router = channel.getWebhookRouter();

		const params = {
			From: "whatsapp:+15559876543",
			To: "whatsapp:+15551234567",
			Body: "hello",
			MessageSid: "SM_TEST_789",
		};

		const req = new Request(ROUTER_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"X-Twilio-Signature": "forged-invalid-signature-base64==",
				"Host": "example.com",
			},
			body: makeFormBody(params),
		});

		const res = await router.fetch(req);
		expect(res.status).toBe(403);
	});

	test("no authToken configured — webhook processes without signature check", async () => {
		const deps = makeMockDeps();
		// No authToken — signature validation should be skipped
		const config = makeWhatsAppConfig({ authToken: undefined });
		const channel = new WhatsAppChannel(config as never, deps);
		const router = channel.getWebhookRouter();

		const params = {
			From: "whatsapp:+15559876543",
			To: "whatsapp:+15551234567",
			Body: "hello no auth",
			MessageSid: "SM_TEST_NOAUTH",
		};

		const req = new Request("https://example.com/", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				// No signature header needed
			},
			body: makeFormBody(params),
		});

		const res = await router.fetch(req);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("<Response>");
	});
});
