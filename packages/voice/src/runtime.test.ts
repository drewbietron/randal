import { describe, expect, test } from "bun:test";
import { parseConfig } from "@randal/core";
import {
	ElevenLabsVoiceRuntime,
	FALLBACK_ELEVENLABS_VOICE_ID,
	LiveKitVoiceRuntime,
	TwilioVoiceRuntime,
} from "./index.js";

const runtimeYaml = `
name: voice-runtime-test
runner:
  workdir: /tmp/test
gateway:
  channels:
    - type: voice
voice:
  enabled: true
  livekit:
    url: https://livekit.example.com
    apiKey: lk-key
    apiSecret: lk-secret
  twilio:
    accountSid: AC123
    authToken: auth-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
`;

function makeConfig(extra = "") {
	return parseConfig(`${runtimeYaml}${extra}`);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const payload = token.split(".")[1];
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("voice runtime providers", () => {
	test("LiveKit runtime generates participant tokens with room grant", async () => {
		const runtime = new LiveKitVoiceRuntime(makeConfig());
		const token = await runtime.generateParticipantToken({
			roomName: "room-1",
			participantName: "caller-1",
		});

		const payload = decodeJwtPayload(token);
		expect(payload.video).toMatchObject({ room: "room-1", roomJoin: true });
		expect(payload.sub).toBe("caller-1");
	});

	test("Twilio runtime builds media stream TwiML", () => {
		const runtime = new TwilioVoiceRuntime(makeConfig());
		const xml = runtime.buildMediaStreamTwiml({
			streamUrl: "wss://voice.example.com/voice/media-stream/session-1",
			statusCallbackUrl: "https://voice.example.com/voice/twilio/stream-status/session-1",
			parameters: { sessionId: "session-1" },
		});

		expect(xml).toContain("<Connect>");
		expect(xml).toContain("wss://voice.example.com/voice/media-stream/session-1");
		expect(xml).toContain("stream-status/session-1");
		expect(xml).toContain('name="sessionId"');
	});

	test("ElevenLabs runtime falls back to built-in voice id when unset", () => {
		const runtime = new ElevenLabsVoiceRuntime(makeConfig());
		expect(runtime.resolveVoiceId()).toBe(FALLBACK_ELEVENLABS_VOICE_ID);
	});

	test("ElevenLabs runtime prefers configured voice id when present", () => {
		const runtime = new ElevenLabsVoiceRuntime(
			parseConfig(`
name: voice-runtime-test
runner:
  workdir: /tmp/test
gateway:
  channels:
    - type: voice
voice:
  enabled: true
  livekit:
    url: https://livekit.example.com
    apiKey: lk-key
    apiSecret: lk-secret
  twilio:
    accountSid: AC123
    authToken: auth-token
    phoneNumber: "+15551234567"
  stt:
    provider: deepgram
    apiKey: deepgram-key
  tts:
    provider: elevenlabs
    apiKey: elevenlabs-key
    voice: custom-voice-id
`),
		);
		expect(runtime.resolveVoiceId()).toBe("custom-voice-id");
	});
});
