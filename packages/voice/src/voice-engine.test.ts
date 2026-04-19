import { describe, expect, mock, test } from "bun:test";
import type { RandalConfig } from "@randal/core";
import { parseConfig } from "@randal/core";
import type { VoiceRuntime } from "./runtime.js";
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
gateway:
  channels:
    - type: voice
voice:
  enabled: true
`;

const fullyEnabledYaml = `
name: test-agent
runner:
  workdir: /tmp/test
gateway:
  channels:
    - type: voice
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: test-api-key
    apiSecret: test-api-secret
  twilio:
    accountSid: ACtestaccountsid1234567890
    authToken: test-auth-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: test-deepgram-key
  tts:
    provider: elevenlabs
    apiKey: test-elevenlabs-key
`;

function makeConfig(yaml: string): RandalConfig {
	return parseConfig(yaml);
}

function makeRuntime(overrides: Partial<VoiceRuntime> = {}): VoiceRuntime {
	const listeners = new Map<string, (payload: unknown) => void>();
	return {
		publicBaseUrl: "https://voice.example.com",
		livekit: {
			ensureRoom: mock(async () => {}),
			generateParticipantToken: mock(async () => "token-123"),
			roomService: {} as VoiceRuntime["livekit"]["roomService"],
		} as VoiceRuntime["livekit"],
		twilio: {
			client: {} as VoiceRuntime["twilio"]["client"],
			createOutboundCall: mock(async () => ({ callSid: "CA123", status: "queued" })),
			buildMediaStreamTwiml: mock(() => "<Response></Response>"),
			validateRequest: mock(() => true),
		} as VoiceRuntime["twilio"],
		deepgram: {
			client: {} as VoiceRuntime["deepgram"]["client"],
			createTranscriptionStream: mock(() => ({
				on: (event: string, listener: (payload: unknown) => void) => {
					listeners.set(event, listener);
				},
				send: mock(() => {}),
				requestClose: mock(() => {}),
			})),
		} as VoiceRuntime["deepgram"],
		elevenlabs: {
			client: {} as VoiceRuntime["elevenlabs"]["client"],
			resolveVoiceId: mock(() => "voice-123"),
			streamSpeech: mock(async () => new ReadableStream<Uint8Array>()),
		} as VoiceRuntime["elevenlabs"],
		vad: {
			createDetector: mock(async () => ({})),
		} as VoiceRuntime["vad"],
		...overrides,
	};
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

		test("start with enabled but missing LiveKit config warns and returns", async () => {
			const config = makeConfig(enabledNoLivekitYaml);
			const engine = new VoiceEngine({ config });

			expect(engine.enabled).toBe(true);
			// Should not throw even without LiveKit config
			await engine.start();
			const sessions = engine.getActiveSessions();
			expect(sessions).toEqual([]);
		});

		test("start with missing Twilio, Deepgram, and ElevenLabs config is a no-op", async () => {
			const config = makeConfig(`
name: test-agent
runner:
  workdir: /tmp/test
gateway:
  channels:
    - type: voice
voice:
  enabled: true
  livekit:
    url: wss://livekit.example.com
    apiKey: livekit-key
    apiSecret: livekit-secret
`);
			const engine = new VoiceEngine({ config });

			await engine.start();
			expect(engine.getActiveSessions()).toEqual([]);
		});

		test("start with full config succeeds", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config });

			expect(engine.enabled).toBe(true);
			await engine.start();
			const sessions = engine.getActiveSessions();
			expect(sessions).toEqual([]);
		});
	});

	describe("createSession", () => {
		test("creates a session with correct fields", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const runtime = makeRuntime();
			const engine = new VoiceEngine({ config, runtime });
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
			const engine = new VoiceEngine({ config, runtime: makeRuntime() });
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
			const engine = new VoiceEngine({ config, runtime: makeRuntime() });
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
				runtime: makeRuntime(),
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
			const engine = new VoiceEngine({ config, runtime: makeRuntime() });
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
			const engine = new VoiceEngine({ config, runtime: makeRuntime() });
			await engine.start();

			const result = await engine.endSession("nonexistent-id");
			expect(result).toBeNull();
		});

		test("calls onSessionEnd callback", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const endedSessions: VoiceSession[] = [];

			const engine = new VoiceEngine({
				config,
				runtime: makeRuntime(),
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
			const engine = new VoiceEngine({ config, runtime: makeRuntime() });
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
			const config = makeConfig(fullyEnabledYaml);
			const runtime = makeRuntime();
			const engine = new VoiceEngine({ config, runtime });
			await engine.start();

			const session = await engine.initiateCall({
				to: "+15551234567",
				reason: "Test call",
			});

			expect(session.status).toBe("active");
			expect(session.callDirection).toBe("outbound");
			expect(session.phoneNumber).toBe("+15551234567");
			expect(session.callSid).toBe("CA123");
			expect(session.roomName.startsWith("call-")).toBe(true);
		});

		test("does not orphan an active session when Twilio call creation fails", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const runtime = makeRuntime({
				twilio: {
					client: {} as VoiceRuntime["twilio"]["client"],
					createOutboundCall: mock(async () => {
						throw new Error("twilio unavailable");
					}),
					buildMediaStreamTwiml: mock(() => "<Response></Response>"),
				} as VoiceRuntime["twilio"],
			});
			const engine = new VoiceEngine({ config, runtime });
			await engine.start();

			await expect(
				engine.initiateCall({
					to: "+15551234567",
					reason: "Test call",
				}),
			).rejects.toThrow("twilio unavailable");
			expect(engine.getActiveSessions()).toHaveLength(0);
		});
	});

	describe("bootstrapInboundCall", () => {
		test("creates inbound session from Twilio call metadata", async () => {
			const engine = new VoiceEngine({
				config: makeConfig(fullyEnabledYaml),
				runtime: makeRuntime(),
			});
			await engine.start();

			const session = await engine.bootstrapInboundCall({
				callSid: "CAINBOUND",
				from: "+15557654321",
			});

			expect(session.callDirection).toBe("inbound");
			expect(session.callSid).toBe("CAINBOUND");
			expect(session.phoneNumber).toBe("+15557654321");
			expect(session.roomName).toBe("inbound-CAINBOUND");
		});

		test("reuses the same session when Twilio retries the inbound webhook", async () => {
			const runtime = makeRuntime();
			const engine = new VoiceEngine({ config: makeConfig(fullyEnabledYaml), runtime });
			await engine.start();

			const first = await engine.bootstrapInboundCall({
				callSid: "CAINBOUND",
				from: "+15557654321",
			});
			const second = await engine.bootstrapInboundCall({
				callSid: "CAINBOUND",
				from: "+15557654321",
			});

			expect(second.id).toBe(first.id);
			expect(runtime.livekit.ensureRoom).toHaveBeenCalledTimes(1);
		});

		test("collapses concurrent inbound retries for the same CallSid", async () => {
			let releaseEnsureRoom: (() => void) | undefined;
			const runtime = makeRuntime({
				livekit: {
					ensureRoom: mock(
						() =>
							new Promise<void>((resolve) => {
								releaseEnsureRoom = resolve;
							}),
					),
					generateParticipantToken: mock(async () => "token-123"),
					roomService: {} as VoiceRuntime["livekit"]["roomService"],
				} as VoiceRuntime["livekit"],
			});
			const engine = new VoiceEngine({ config: makeConfig(fullyEnabledYaml), runtime });
			await engine.start();

			const first = engine.bootstrapInboundCall({
				callSid: "CAINBOUND",
				from: "+15557654321",
			});
			const second = engine.bootstrapInboundCall({
				callSid: "CAINBOUND",
				from: "+15557654321",
			});

			expect(runtime.livekit.ensureRoom).toHaveBeenCalledTimes(1);
			releaseEnsureRoom?.();

			const [firstSession, secondSession] = await Promise.all([first, second]);
			expect(firstSession.id).toBe(secondSession.id);
			expect(runtime.livekit.ensureRoom).toHaveBeenCalledTimes(1);
		});

		test("buildInboundTwiml reuses the media-stream TwiML path", async () => {
			const runtime = makeRuntime();
			const engine = new VoiceEngine({ config: makeConfig(fullyEnabledYaml), runtime });
			await engine.start();

			const xml = engine.buildInboundTwiml("session-inbound-1");
			expect(xml).toBe("<Response></Response>");
			expect(runtime.twilio.buildMediaStreamTwiml).toHaveBeenCalledTimes(1);
		});

		test("inbound sessions end cleanly through the shared Twilio status callback", async () => {
			const engine = new VoiceEngine({
				config: makeConfig(fullyEnabledYaml),
				runtime: makeRuntime(),
			});
			await engine.start();
			const session = await engine.bootstrapInboundCall({
				callSid: "CAINBOUND",
				from: "+15557654321",
			});

			await engine.handleTwilioStatusCallback(session.id, {
				CallSid: "CAINBOUND",
				CallStatus: "completed",
			});

			expect(engine.getSession(session.id)?.status).toBe("ended");
		});
	});

	describe("generateRoomToken", () => {
		test("delegates to runtime LiveKit token generation", async () => {
			const runtime = makeRuntime();
			const engine = new VoiceEngine({ config: makeConfig(fullyEnabledYaml), runtime });
			await engine.start();

			const token = await engine.generateRoomToken("room-1", "participant-1");
			expect(token).toBe("token-123");
			expect(runtime.livekit.generateParticipantToken).toHaveBeenCalledTimes(1);
		});
	});

	describe("buildOutboundTwiml", () => {
		test("uses runtime TwiML builder with media stream endpoints", async () => {
			const runtime = makeRuntime();
			const engine = new VoiceEngine({ config: makeConfig(fullyEnabledYaml), runtime });
			await engine.start();

			const xml = engine.buildOutboundTwiml("session-1");
			expect(xml).toBe("<Response></Response>");
			expect(runtime.twilio.buildMediaStreamTwiml).toHaveBeenCalledTimes(1);
		});
	});

	describe("Twilio media loop", () => {
		test("forwards final Deepgram transcripts into the session transcript handler", async () => {
			let transcriptHandler: ((payload: unknown) => void) | undefined;
			const deepgramStream = {
				on: (event: string, listener: (payload: unknown) => void) => {
					if (event === "Results") transcriptHandler = listener;
				},
				send: mock(() => {}),
				requestClose: mock(() => {}),
			};
			const runtime = makeRuntime({
				deepgram: {
					client: {} as VoiceRuntime["deepgram"]["client"],
					createTranscriptionStream: mock(() => deepgramStream),
				} as VoiceRuntime["deepgram"],
			});
			const transcripts: string[] = [];
			const engine = new VoiceEngine({
				config: makeConfig(fullyEnabledYaml),
				runtime,
				onTranscript: (_sessionId, text) => transcripts.push(text),
			});
			await engine.start();
			const session = await engine.createSession({ roomName: "room-1", direction: "inbound" });

			const finalTurns: string[] = [];
			engine.startTwilioMediaStream({
				sessionId: session.id,
				streamSid: "MZ123",
				sendMessage: mock(() => {}),
				onFinalTranscript: async (text) => {
					finalTurns.push(text);
				},
			});

			transcriptHandler?.({
				channel: { alternatives: [{ transcript: "hello from caller" }] },
				is_final: true,
			});

			await Promise.resolve();
			expect(finalTurns).toEqual(["hello from caller"]);
			expect(transcripts).toEqual(["hello from caller"]);
			expect(engine.getSession(session.id)?.transcript).toEqual(["hello from caller"]);
		});

		test("sends ElevenLabs audio back to Twilio media stream", async () => {
			const outboundMessages: Array<Record<string, unknown>> = [];
			const runtime = makeRuntime({
				elevenlabs: {
					client: {} as VoiceRuntime["elevenlabs"]["client"],
					resolveVoiceId: mock(() => "voice-123"),
					streamSpeech: mock(
						async () =>
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(new Uint8Array([1, 2, 3]));
									controller.close();
								},
							}),
					),
				} as VoiceRuntime["elevenlabs"],
			});
			const engine = new VoiceEngine({ config: makeConfig(fullyEnabledYaml), runtime });
			await engine.start();
			const session = await engine.createSession({ roomName: "room-1", direction: "outbound" });

			engine.startTwilioMediaStream({
				sessionId: session.id,
				streamSid: "MZ123",
				sendMessage: (message) => outboundMessages.push(message),
				onFinalTranscript: async () => {},
			});

			await engine.speakToSession(session.id, "hello there");
			expect(outboundMessages).toHaveLength(1);
			expect(outboundMessages[0].event).toBe("media");
			expect(outboundMessages[0].streamSid).toBe("MZ123");
		});

		test("barge-in clears only active playback and later speech can resume", async () => {
			const outboundMessages: Array<Record<string, unknown>> = [];
			let releaseFirstStream: (() => void) | undefined;
			let invocation = 0;
			const runtime = makeRuntime({
				elevenlabs: {
					client: {} as VoiceRuntime["elevenlabs"]["client"],
					resolveVoiceId: mock(() => "voice-123"),
					streamSpeech: mock(async () => {
						invocation += 1;
						if (invocation === 1) {
							return new ReadableStream<Uint8Array>({
								async start(controller) {
									controller.enqueue(new Uint8Array([1, 2, 3]));
									await new Promise<void>((resolve) => {
										releaseFirstStream = resolve;
									});
									controller.close();
								},
							});
						}

						return new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array([4, 5, 6]));
								controller.close();
							},
						});
					}),
				} as VoiceRuntime["elevenlabs"],
			});
			const engine = new VoiceEngine({ config: makeConfig(fullyEnabledYaml), runtime });
			await engine.start();
			const session = await engine.createSession({ roomName: "room-1", direction: "outbound" });

			engine.startTwilioMediaStream({
				sessionId: session.id,
				streamSid: "MZ123",
				sendMessage: (message) => outboundMessages.push(message),
				onFinalTranscript: async () => {},
			});

			const firstSpeech = engine.speakToSession(session.id, "first response");
			await Promise.resolve();
			engine.handleTwilioMediaChunk(session.id, Buffer.from([7, 8, 9]).toString("base64"));
			releaseFirstStream?.();
			await firstSpeech;

			await engine.speakToSession(session.id, "second response");

			expect(outboundMessages[0]).toEqual({ event: "clear", streamSid: "MZ123" });
			expect(outboundMessages.some((message) => message.event === "media")).toBe(true);
			expect(outboundMessages.filter((message) => message.event === "clear")).toHaveLength(1);
		});

		test("terminal Twilio status ends the session", async () => {
			const engine = new VoiceEngine({
				config: makeConfig(fullyEnabledYaml),
				runtime: makeRuntime(),
			});
			await engine.start();
			const session = await engine.createSession({ roomName: "room-1", direction: "outbound" });

			await engine.handleTwilioStatusCallback(session.id, {
				CallSid: "CA123",
				CallStatus: "completed",
			});

			expect(engine.getSession(session.id)?.status).toBe("ended");
		});
	});

	describe("joinVideoCall", () => {
		test("creates video session", async () => {
			const config = makeConfig(fullyEnabledYaml);
			const engine = new VoiceEngine({ config, runtime: makeRuntime() });
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
			const engine = new VoiceEngine({ config, runtime: makeRuntime() });
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
			const engine = new VoiceEngine({ config, runtime: makeRuntime() });

			// Should not throw
			await engine.stop();
			expect(engine.getActiveSessions()).toHaveLength(0);
		});
	});
});
