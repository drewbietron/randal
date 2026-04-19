import { describe, expect, mock, test } from "bun:test";
import { type RunnerEvent, parseConfig } from "@randal/core";
import { Runner } from "@randal/runner";
import { createHttpApp } from "./channels/http.js";
import { VoiceChannel } from "./channels/voice.js";
import { EventBus } from "./events.js";

function makeTestApp(overrides: Record<string, unknown> = {}) {
	const config = parseConfig(`
name: test-gateway
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
`);

	const eventBus = new EventBus();
	const runner = new Runner({
		config,
		onEvent: (e) => eventBus.emit(e),
	});

	const app = createHttpApp({ config, runner, eventBus, ...overrides });
	return { app, config, runner, eventBus };
}

function makeMockVoiceService(overrides: Record<string, unknown> = {}) {
	return {
		initiateCall: mock(async () => ({
			id: "session-1",
			callSid: "TEST_CALL_ID_123",
			roomName: "call-1",
			status: "queued",
			callDirection: "outbound" as const,
			phoneNumber: "+15557654321",
		})),
		bootstrapInboundCall: mock(async () => ({
			id: "session-inbound-1",
			callSid: "INBOUND_TEST_CALL_ID",
			roomName: "inbound-INBOUND_TEST_CALL_ID",
			status: "active",
			callDirection: "inbound" as const,
			phoneNumber: "+15557654321",
		})),
		buildOutboundTwiml: mock(() => "<Response><Connect /></Response>"),
		buildInboundTwiml: mock(() => "<Response><Connect /></Response>"),
		getSession: mock(() => ({ phoneNumber: "+15557654321" })),
		validateTwilioRequest: mock(() => true),
		startTwilioMediaStream: mock(() => {}),
		handleTwilioMediaChunk: mock(() => {}),
		stopTwilioMediaStream: mock(() => {}),
		speakToSession: mock(async () => {}),
		handleTwilioStatusCallback: mock(async () => ({})),
		handleTwilioStreamStatus: mock(async () => ({})),
		...overrides,
	};
}

describe("HTTP API", () => {
	test("GET /health returns ok without auth", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("ok");
	});

	test("GET /health returns ok with auth too", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/health", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("ok");
	});

	test("GET /instance returns info", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/instance", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe("test-gateway");
	});

	test("POST /job requires prompt", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/job", {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("GET /jobs returns empty initially", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/jobs", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const jobs = await res.json();
		expect(Array.isArray(jobs)).toBe(true);
	});

	test("GET /job/:id returns 404 for unknown", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/job/nonexistent", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	test("DELETE /job/:id returns 404 for unknown", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/job/nonexistent", {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	test("GET /config returns sanitized config with skills", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/config", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe("test-gateway");
		expect(data.credentials).toBeDefined();
		expect(data.skills).toBeDefined();
		expect(data.skills.dir).toBe("./skills");
		expect(data.skills.autoDiscover).toBe(true);
		expect(data.skills.maxPerPrompt).toBe(5);
		// Verify no raw credential values are exposed
		const serialized = JSON.stringify(data);
		expect(serialized).not.toContain("test-token");
	});

	test("GET / returns dashboard HTML", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		// Dashboard is loaded from the actual file or fallback
		expect(html).toContain("Randal");
	});

	test("GET /skills returns empty when no skill manager", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const skills = await res.json();
		expect(Array.isArray(skills)).toBe(true);
		expect(skills).toHaveLength(0);
	});

	test("GET /skills/search requires q parameter", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills/search", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBe("q parameter required");
	});

	test("GET /skills/:name returns 400 when no skill manager", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills/nonexistent", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(400);
	});

	test("GET /voice/status returns structured unavailable response when voice is off", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/voice/status", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.error).toBe("voice unavailable");
		expect(data.code).toBe("VOICE_UNAVAILABLE");
		expect(data.reason).toBe("voice disabled");
		expect(data.available).toBe(false);
		expect(data.sessions).toEqual([]);
	});

	test("GET /voice/status reports missing voice config when channel is enabled but incomplete", async () => {
		const config = parseConfig(`
name: test-gateway
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
    - type: voice
voice:
  enabled: true
`);

		const eventBus = new EventBus();
		const runner = new Runner({
			config,
			onEvent: (e) => eventBus.emit(e),
		});
		const app = createHttpApp({ config, runner, eventBus });

		const res = await app.request("/voice/status", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.reason).toBe("voice config incomplete");
		expect(data.missing).toContain("voice.livekit.url");
		expect(data.missing).toContain("voice.twilio.accountSid");
		expect(data.missing).toContain("voice.stt.apiKey");
		expect(data.missing).toContain("voice.tts.apiKey");
	});

	test("GET /voice/status reflects live voice adapter sessions via adapter registry", async () => {
		const config = parseConfig(`
name: test-gateway
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
    - type: voice
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: livekit-key
    apiSecret: livekit-secret
  twilio:
    accountSid: twilio-test-account-id
    authToken: twilio-test-auth-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
`);

		const eventBus = new EventBus();
		const runner = new Runner({
			config,
			onEvent: (e) => eventBus.emit(e),
		});
		const channelAdapters: unknown[] = [];
		const app = createHttpApp({
			config,
			runner,
			eventBus,
			channelAdapters: channelAdapters as never,
		});

		const voiceChannel = new VoiceChannel(
			{ type: "voice" },
			{
				config,
				runner,
				eventBus,
			},
		);
		voiceChannel.registerSession(
			"session-1",
			"+15551234567",
			mock(() => {}),
		);
		channelAdapters.push(voiceChannel);

		const res = await app.request("/voice/status", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.available).toBe(true);
		expect(data.enabled).toBe(true);
		expect(data.sessions).toHaveLength(1);
		expect(data.sessions[0].id).toBe("session-1");
		expect(data.sessions[0].callId).toBe("session-1");
	});

	test("GET /voice/status reflects provider-backed voice lifecycle sessions", async () => {
		const config = parseConfig(`
name: test-gateway
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
    - type: voice
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: livekit-key
    apiSecret: livekit-secret
  twilio:
    accountSid: twilio-test-account-id
    authToken: twilio-test-auth-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
`);

		const eventBus = new EventBus();
		const runner = new Runner({
			config,
			onEvent: (e) => eventBus.emit(e),
		});
		const app = createHttpApp({
			config,
			runner,
			eventBus,
			voiceManager: {
				isEnabled: () => true,
				getSessions: () => [
					{
						id: "session-provider-1",
						callId: "TEST_CALL_ID_123",
						status: "active",
						duration: 42,
						transcriptLength: 3,
						startedAt: new Date("2026-04-19T00:00:00.000Z").toISOString(),
					},
				],
			},
		});

		const res = await app.request("/voice/status", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.available).toBe(true);
		expect(data.sessions).toEqual([
			{
				id: "session-provider-1",
				callId: "TEST_CALL_ID_123",
				status: "active",
				duration: 42,
				transcriptLength: 3,
				startedAt: "2026-04-19T00:00:00.000Z",
			},
		]);
	});

	test("POST /voice/call returns structured unavailable response when voice is off", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/voice/call", {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ to: "+15551234567" }),
		});
		expect(res.status).toBe(503);
		const data = await res.json();
		expect(data.code).toBe("VOICE_UNAVAILABLE");
	});

	test("POST /voice/call delegates to voice service when available", async () => {
		const config = parseConfig(`
name: test-gateway
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
    - type: voice
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: livekit-key
    apiSecret: livekit-secret
  twilio:
    accountSid: twilio-test-account-id
    authToken: twilio-test-auth-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
`);

		const eventBus = new EventBus();
		const runner = new Runner({
			config,
			onEvent: (e) => eventBus.emit(e),
		});
		const voiceService = makeMockVoiceService();
		const app = createHttpApp({
			config,
			runner,
			eventBus,
			voiceService,
		});

		const res = await app.request("/voice/call", {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ to: "+15557654321", reason: "Test" }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.callSid).toBe("TEST_CALL_ID_123");
		expect(data.sessionId).toBe("session-1");
		expect(voiceService.initiateCall).toHaveBeenCalledTimes(1);
	});

	test("POST /voice/twiml/outbound/:sessionId returns TwiML with valid Twilio signature", async () => {
		const voiceService = makeMockVoiceService();
		const { app } = makeTestApp({ voiceService });

		const res = await app.request("/voice/twiml/outbound/session-1", {
			method: "POST",
			headers: {
				"X-Twilio-Signature": "valid",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "CallSid=TEST_CALL_ID_123&CallStatus=ringing",
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/xml");
		expect(await res.text()).toContain("<Response>");
		expect(voiceService.validateTwilioRequest).toHaveBeenCalledTimes(1);
		expect(voiceService.validateTwilioRequest.mock.calls[0]?.[2]).toEqual({
			CallSid: "TEST_CALL_ID_123",
			CallStatus: "ringing",
		});
	});

	test("POST /voice/twiml/outbound/:sessionId rejects invalid Twilio signatures", async () => {
		const voiceService = makeMockVoiceService({ validateTwilioRequest: mock(() => false) });
		const { app } = makeTestApp({ voiceService });

		const res = await app.request("/voice/twiml/outbound/session-1", { method: "POST" });
		expect(res.status).toBe(401);
	});

	test("POST /voice/twiml/inbound bootstraps an inbound session and returns TwiML", async () => {
		const voiceService = makeMockVoiceService();
		const { app } = makeTestApp({ voiceService });

		const res = await app.request("/voice/twiml/inbound", {
			method: "POST",
			headers: {
				"X-Twilio-Signature": "valid",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "CallSid=INBOUND_TEST_CALL_ID&From=%2B15557654321",
		});

		expect(res.status).toBe(200);
		expect(await res.text()).toContain("<Response>");
		expect(voiceService.bootstrapInboundCall).toHaveBeenCalledTimes(1);
		expect(voiceService.bootstrapInboundCall.mock.calls[0]?.[0]).toEqual({
			callSid: "INBOUND_TEST_CALL_ID",
			from: "+15557654321",
		});
		expect(voiceService.buildInboundTwiml).toHaveBeenCalledWith("session-inbound-1");
	});

	test("inbound sessions clean up through the shared Twilio status callback route", async () => {
		const voiceService = makeMockVoiceService({
			handleTwilioStatusCallback: mock(async () => ({ status: "ended" })),
		});
		const { app } = makeTestApp({ voiceService });

		const res = await app.request("/voice/twilio/status/session-inbound-1", {
			method: "POST",
			headers: {
				"X-Twilio-Signature": "valid",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "CallSid=INBOUND_TEST_CALL_ID&CallStatus=completed",
		});

		expect(res.status).toBe(200);
		expect(voiceService.handleTwilioStatusCallback).toHaveBeenCalledTimes(1);
	});

	test("POST /voice/twiml/inbound requires CallSid", async () => {
		const voiceService = makeMockVoiceService();
		const { app } = makeTestApp({ voiceService });

		const res = await app.request("/voice/twiml/inbound", {
			method: "POST",
			headers: {
				"X-Twilio-Signature": "valid",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "From=%2B15557654321",
		});

		expect(res.status).toBe(400);
		expect(voiceService.bootstrapInboundCall).not.toHaveBeenCalled();
	});

	test("Twilio callback routes are public but signature-validated", async () => {
		const voiceService = makeMockVoiceService();
		const { app } = makeTestApp({ voiceService });

		const statusRes = await app.request("/voice/twilio/status/session-1", {
			method: "POST",
			headers: {
				"X-Twilio-Signature": "valid",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "CallSid=TEST_CALL_ID_123&CallStatus=completed",
		});
		expect(statusRes.status).toBe(200);
		expect(voiceService.handleTwilioStatusCallback).toHaveBeenCalledTimes(1);

		const streamStatusRes = await app.request("/voice/twilio/stream-status/session-1", {
			method: "POST",
			headers: {
				"X-Twilio-Signature": "valid",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "StreamEvent=stream-stopped",
		});
		expect(streamStatusRes.status).toBe(200);
		expect(voiceService.handleTwilioStreamStatus).toHaveBeenCalledTimes(1);
	});

	test("GET /voice/media-stream/:sessionId rejects missing Twilio signature", async () => {
		const voiceService = makeMockVoiceService({ validateTwilioRequest: mock(() => false) });
		const { app } = makeTestApp({ voiceService });

		const res = await app.request("/voice/media-stream/session-1");
		expect(res.status).toBe(401);
	});

	test("non-public voice routes still require bearer auth", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/voice/status");
		expect(res.status).toBe(401);
	});

	test("POST /voice/call validates E.164 phone numbers", async () => {
		const config = parseConfig(`
name: test-gateway
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
    - type: voice
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: livekit-key
    apiSecret: livekit-secret
  twilio:
    accountSid: twilio-test-account-id
    authToken: twilio-test-auth-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
`);

		const eventBus = new EventBus();
		const runner = new Runner({
			config,
			onEvent: (e) => eventBus.emit(e),
		});
		const app = createHttpApp({
			config,
			runner,
			eventBus,
			voiceService: makeMockVoiceService(),
		});

		const res = await app.request("/voice/call", {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ to: "5551234567" }),
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toContain("E.164");
	});

	test("POST /voice/call returns structured upstream failures", async () => {
		const config = parseConfig(`
name: test-gateway
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
    - type: voice
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: livekit-key
    apiSecret: livekit-secret
  twilio:
    accountSid: twilio-test-account-id
    authToken: twilio-test-auth-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
`);

		const eventBus = new EventBus();
		const runner = new Runner({
			config,
			onEvent: (e) => eventBus.emit(e),
		});
		const app = createHttpApp({
			config,
			runner,
			eventBus,
			voiceService: makeMockVoiceService({
				initiateCall: mock(async () => {
					throw new Error("twilio unavailable");
				}),
			}),
		});

		const res = await app.request("/voice/call", {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ to: "+15557654321" }),
		});
		expect(res.status).toBe(502);
		const data = await res.json();
		expect(data.code).toBe("VOICE_CALL_FAILED");
	});
});

// ---- Posse endpoint tests ----

function makePosseTestApp() {
	const config = parseConfig(`
name: test-agent
posse: test-team
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
memory:
  sharing:
    publishTo: "shared-test-team"
    readFrom: ["shared-test-team"]
`);

	const eventBus = new EventBus();
	const runner = new Runner({
		config,
		onEvent: (e) => eventBus.emit(e),
	});

	const app = createHttpApp({ config, runner, eventBus });
	return { app, config, runner, eventBus };
}

describe("Posse HTTP API", () => {
	test("GET /posse returns 404 when posse not configured", async () => {
		const { app } = makeTestApp(); // no posse in config
		const res = await app.request("/posse", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toBe("Not a posse member");
	});

	test("GET /posse returns posse info when configured", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.posse).toBe("test-team");
		expect(data.self).toBe("test-agent");
		expect(Array.isArray(data.agents)).toBe(true);
	});

	test("GET /posse/memory/search returns 404 when no posse", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/posse/memory/search?q=test", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	test("GET /posse/memory/search requires q parameter", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/search", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(400);
	});

	test("GET /posse/memory/search?scope=self returns empty without memory manager", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/search?q=test&scope=self", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
	});

	test("GET /posse/memory/recent returns 404 when no posse", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/posse/memory/recent", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	test("GET /posse/memory/recent returns empty without memory manager", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/recent?scope=self", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
	});

	test("All /posse/* endpoints require authentication", async () => {
		const { app } = makePosseTestApp();

		const endpoints = ["/posse", "/posse/memory/search?q=test", "/posse/memory/recent"];
		for (const ep of endpoints) {
			const res = await app.request(ep);
			expect(res.status).toBe(401);
		}
	});
});

// ---- Internal Events API tests ----

describe("Internal Events API", () => {
	test("POST /_internal/events emits brain event to EventBus", async () => {
		const { app, eventBus } = makeTestApp();
		const events: RunnerEvent[] = [];
		eventBus.subscribe((e) => events.push(e));

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "test-job",
				message: "Build complete",
			}),
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.emitted).toBe(true);
		expect(data.type).toBe("brain.notification");

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("brain.notification");
		expect(events[0].jobId).toBe("test-job");
		expect(events[0].data.message).toBe("Build complete");
	});

	test("POST /_internal/events requires type, jobId, message", async () => {
		const { app } = makeTestApp();

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "notification" }),
		});

		expect(res.status).toBe(400);
	});

	test("POST /_internal/events rejects invalid type", async () => {
		const { app } = makeTestApp();

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "invalid",
				jobId: "test-job",
				message: "hello",
			}),
		});

		expect(res.status).toBe(400);
	});

	test("POST /_internal/events rate limits repeated calls", async () => {
		const { app } = makeTestApp();

		// First call succeeds
		const res1 = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "rate-test",
				message: "first",
			}),
		});
		expect(res1.status).toBe(200);

		// Second call within 10s is rate limited
		const res2 = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "rate-test",
				message: "second",
			}),
		});
		expect(res2.status).toBe(429);
		const data = await res2.json();
		expect(data.retryAfterSeconds).toBeGreaterThan(0);
	});

	test("POST /_internal/events allows different types for same job", async () => {
		const { app } = makeTestApp();

		const res1 = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "multi-type",
				message: "notif",
			}),
		});
		expect(res1.status).toBe(200);

		// Different type for same job should succeed
		const res2 = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "alert",
				jobId: "multi-type",
				message: "alert",
			}),
		});
		expect(res2.status).toBe(200);
	});

	test("POST /_internal/events does not require auth token", async () => {
		const { app } = makeTestApp();

		// No Authorization header — should still work (internal endpoint)
		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "no-auth",
				message: "no auth needed",
			}),
		});
		expect(res.status).toBe(200);
	});

	test("POST /_internal/events includes severity in emitted event", async () => {
		const { app, eventBus } = makeTestApp();
		const events: RunnerEvent[] = [];
		eventBus.subscribe((e) => events.push(e));

		await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "alert",
				jobId: "sev-test",
				message: "critical issue",
				severity: "critical",
			}),
		});

		expect(events).toHaveLength(1);
		expect(events[0].data.severity).toBe("critical");
	});

	test("POST /_internal/events → EventBus → subscriber receives formatted event", async () => {
		const { app, eventBus } = makeTestApp();
		const received: string[] = [];

		// Simulate a channel adapter subscribing
		eventBus.subscribe((event) => {
			if (event.type === "brain.alert") {
				const sev = event.data.severity ?? "warning";
				const prefix = sev === "critical" ? "CRITICAL" : "ALERT";
				received.push(`**${prefix}**: ${event.data.message}`);
			}
		});

		await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "alert",
				jobId: "e2e-test",
				message: "Build stuck on step 7",
				severity: "critical",
			}),
		});

		expect(received).toHaveLength(1);
		expect(received[0]).toBe("**CRITICAL**: Build stuck on step 7");
	});
});
