import { describe, expect, test } from "bun:test";
import type { RandalConfig } from "@randal/core";
import { parseConfig } from "@randal/core";
import { VoiceEngine } from "./voice-engine.js";
import type { VoiceSession } from "./voice-engine.js";

const minimalYaml = `
name: test-agent
runner:
  workdir: /tmp/test
voice:
  enabled: false
`;

const enabledNoLivekitYaml = `
name: test-agent
runner:
  workdir: /tmp/test
voice:
  enabled: true
`;

const browserOnlyYaml = `
name: test-agent
runner:
  workdir: /tmp/test
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: test-api-key
    apiSecret: test-api-secret
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: edge
    voice: en-US-GuyNeural
`;

const fullyEnabledYaml = `
name: test-agent
runner:
  workdir: /tmp/test
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: test-api-key
    apiSecret: test-api-secret
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
    voice: test-voice
`;

const pstnReadyYaml = `
name: test-agent
runner:
  workdir: /tmp/test
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: test-api-key
    apiSecret: test-api-secret
  twilio:
    accountSid: twilio-account
    authToken: twilio-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
    voice: test-voice
`;

function makeConfig(yaml: string): RandalConfig {
	return parseConfig(yaml);
}

describe("VoiceEngine", () => {
	describe("start", () => {
		test("start with disabled config is a no-op", async () => {
			const config = makeConfig(minimalYaml);
			const engine = new VoiceEngine({ config });

			expect(engine.enabled).toBe(false);
			await engine.start();
			// Should not throw, should be a no-op
			const sessions = engine.getActiveSessions();
			expect(sessions).toEqual([]);
		});

		test("start with enabled but missing browser/media config warns and returns", async () => {
			const config = makeConfig(enabledNoLivekitYaml);
			const engine = new VoiceEngine({ config });

			expect(engine.enabled).toBe(true);
			// Should not throw even without LiveKit config
			await engine.start();
			const sessions = engine.getActiveSessions();
			expect(sessions).toEqual([]);
		});

		test("start with full config succeeds", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });

			expect(engine.enabled).toBe(true);
			await engine.start();
			const sessions = engine.getActiveSessions();
			expect(sessions).toEqual([]);
		});

		test("browser-only config starts without Twilio", async () => {
			const config = makeConfig(browserOnlyYaml);
			const engine = new VoiceEngine({ config });

			expect(engine.isBrowserVoiceReady()).toBe(true);
			expect(engine.isPstnVoiceReady()).toBe(false);
			await engine.start();
			expect(engine.getActiveSessions()).toEqual([]);
		});
	});

	describe("createSession", () => {
		test("creates a session with correct fields", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const session = await engine.createSession({
				roomName: "test-room",
				direction: "inbound",
			});

			expect(session.id).toBeDefined();
			expect(session.id.startsWith("vs-")).toBe(true);
			expect(session.roomName).toBe("test-room");
			expect(session.participantId).toBe("randal-test-agent");
			expect(session.status).toBe("active");
			expect(session.transcript).toEqual([]);
			expect(session.startedAt).toBeDefined();
		});

		test("session is retrievable via getSession", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const session = await engine.createSession({
				roomName: "test-room",
				direction: "inbound",
			});
			const retrieved = engine.getSession(session.id);

			expect(retrieved).toBeDefined();
			expect(retrieved?.id).toBe(session.id);
		});
	});

	describe("addTranscript", () => {
		test("adds text to session transcript", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const session = await engine.createSession({
				roomName: "test-room",
				direction: "inbound",
			});

			engine.addTranscript(session.id, "Hello, world");
			engine.addTranscript(session.id, "How are you?");

			const updated = engine.getSession(session.id);
			expect(updated?.transcript).toEqual(["Hello, world", "How are you?"]);
		});

		test("calls onTranscript callback when provided", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const transcriptCalls: Array<{ sessionId: string; text: string }> = [];

			const engine = new VoiceEngine({
				config,
				onTranscript: (sessionId, text) => {
					transcriptCalls.push({ sessionId, text });
				},
			});
			await engine.start();

			const session = await engine.createSession({
				roomName: "test-room",
				direction: "inbound",
			});

			engine.addTranscript(session.id, "Test text");
			expect(transcriptCalls).toHaveLength(1);
			expect(transcriptCalls[0].sessionId).toBe(session.id);
			expect(transcriptCalls[0].text).toBe("Test text");
		});
	});

	describe("endSession", () => {
		test("marks session as ended and calculates duration", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const session = await engine.createSession({
				roomName: "test-room",
				direction: "inbound",
			});

			// Small delay to ensure non-zero duration
			await new Promise((resolve) => setTimeout(resolve, 50));

			const ended = await engine.endSession(session.id);
			expect(ended).not.toBeNull();
			expect(ended?.status).toBe("ended");
			expect(ended?.duration).toBeGreaterThanOrEqual(0);
		});

		test("returns null for nonexistent session", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const result = await engine.endSession("nonexistent-id");
			expect(result).toBeNull();
		});

		test("calls onSessionEnd callback", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const endedSessions: VoiceSession[] = [];

			const engine = new VoiceEngine({
				config,
				onSessionEnd: (session) => {
					endedSessions.push(session);
				},
			});
			await engine.start();

			const session = await engine.createSession({
				roomName: "test-room",
				direction: "inbound",
			});

			await engine.endSession(session.id);
			expect(endedSessions).toHaveLength(1);
			expect(endedSessions[0].id).toBe(session.id);
			expect(endedSessions[0].status).toBe("ended");
		});
	});

	describe("getActiveSessions", () => {
		test("returns only active sessions", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const s1 = await engine.createSession({
				roomName: "room-1",
				direction: "inbound",
			});
			const s2 = await engine.createSession({
				roomName: "room-2",
				direction: "inbound",
			});
			await engine.createSession({
				roomName: "room-3",
				direction: "inbound",
			});

			await engine.endSession(s1.id);

			const active = engine.getActiveSessions();
			expect(active).toHaveLength(2);
			expect(active.find((s) => s.id === s1.id)).toBeUndefined();
			expect(active.find((s) => s.id === s2.id)).toBeDefined();
		});
	});

	describe("initiateCall", () => {
		test("creates outbound session with phone number", async () => {
			const config = makeConfig(pstnReadyYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const session = await engine.initiateCall({
				to: "+15551234567",
				reason: "Test call",
			});

			expect(session.status).toBe("active");
			expect(session.callDirection).toBe("outbound");
			expect(session.phoneNumber).toBe("+15551234567");
			expect(session.roomName.startsWith("call-")).toBe(true);
		});

		test("fails clearly without Twilio config", async () => {
			const config = makeConfig(browserOnlyYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			await expect(
				engine.initiateCall({
					to: "+15551234567",
					reason: "Test call",
				}),
			).rejects.toThrow("PSTN voice requires Twilio");
		});
	});

	describe("generateRoomToken", () => {
		test("works for browser-only voice config", async () => {
			const config = makeConfig(browserOnlyYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const token = await engine.generateRoomToken("browser-room", "browser-user");
			expect(token).toContain("browser-room");
		});

		test("fails clearly without browser/media config", async () => {
			const config = makeConfig(enabledNoLivekitYaml);
			const engine = new VoiceEngine({ config });

			await expect(engine.generateRoomToken("browser-room", "browser-user")).rejects.toThrow(
				"Browser/media voice requires LiveKit, STT, and TTS configuration",
			);
		});
	});

	describe("joinVideoCall", () => {
		test("creates video session", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			const session = await engine.joinVideoCall({
				platform: "zoom",
				meetingId: "123-456-789",
			});

			expect(session.status).toBe("active");
			expect(session.callDirection).toBe("outbound");
			expect(session.roomName).toBe("video-zoom-123-456-789");
		});
	});

	describe("stop", () => {
		test("ends all active sessions", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });
			await engine.start();

			await engine.createSession({
				roomName: "room-1",
				direction: "inbound",
			});
			await engine.createSession({
				roomName: "room-2",
				direction: "outbound",
			});

			expect(engine.getActiveSessions()).toHaveLength(2);

			await engine.stop();

			expect(engine.getActiveSessions()).toHaveLength(0);
		});

		test("stop on non-started engine is a no-op", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });

			// Should not throw
			await engine.stop();
			expect(engine.getActiveSessions()).toHaveLength(0);
		});
	});
});
