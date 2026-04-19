import { describe, expect, test } from "bun:test";
import { parseConfig } from "@randal/core";
import { DeepgramVoiceRuntime, ElevenLabsVoiceRuntime, LiveKitVoiceRuntime } from "./index.js";

const shouldRunProviderTests = process.env.RANDAL_RUN_PROVIDER_TESTS === "1";
const requiredProviderEnv = [
	"LIVEKIT_URL",
	"LIVEKIT_API_KEY",
	"LIVEKIT_API_SECRET",
	"DEEPGRAM_API_KEY",
	"ELEVENLABS_API_KEY",
];

const hasRequiredProviderEnv = requiredProviderEnv.every((name) => {
	const value = process.env[name];
	return typeof value === "string" && value.length > 0;
});

// These are credentialed provider smoke tests. They verify SDK/client wiring and
// basic authenticated operations, not end-to-end telephony correctness.
const describeProvider =
	shouldRunProviderTests && hasRequiredProviderEnv ? describe : describe.skip;

function integrationConfig() {
	return parseConfig(`
name: voice-integration-test
runner:
  workdir: /tmp/test
gateway:
  channels:
    - type: voice
voice:
  enabled: true
  livekit:
    url: ${process.env.LIVEKIT_URL}
    apiKey: ${process.env.LIVEKIT_API_KEY}
    apiSecret: ${process.env.LIVEKIT_API_SECRET}
  twilio:
    accountSid: ${process.env.TWILIO_ACCOUNT_SID ?? "ACtest"}
    authToken: ${process.env.TWILIO_AUTH_TOKEN ?? "test-token"}
    phoneNumber: ${process.env.TWILIO_PHONE_NUMBER ?? "+15550000000"}
  stt:
    provider: deepgram
    apiKey: ${process.env.DEEPGRAM_API_KEY}
  tts:
    provider: elevenlabs
    apiKey: ${process.env.ELEVENLABS_API_KEY}
    voice: ${process.env.ELEVENLABS_VOICE_ID ?? ""}
`);
}

describeProvider("voice provider credentialed smoke tests", () => {
	test("generates a syntactically valid LiveKit token with configured credentials", async () => {
		const runtime = new LiveKitVoiceRuntime(integrationConfig());
		const token = await runtime.generateParticipantToken({
			roomName: `it-room-${Date.now()}`,
			participantName: "integration-tester",
		});
		expect(token.split(".")).toHaveLength(3);
	});

	test("opens and closes a Deepgram live transcription client", async () => {
		const runtime = new DeepgramVoiceRuntime(integrationConfig());
		const stream = runtime.createTranscriptionStream();
		expect(stream).toBeDefined();
		stream.requestClose();
	});

	test("requests an ElevenLabs audio stream when provider credentials are present", async () => {
		const runtime = new ElevenLabsVoiceRuntime(integrationConfig());
		const stream = await runtime.streamSpeech("Integration test hello from Randal.");
		const reader = stream.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		if (!first.done) {
			expect(first.value.byteLength).toBeGreaterThan(0);
		}
		await reader.cancel();
	});
});
