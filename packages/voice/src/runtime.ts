import type { RandalConfig } from "@randal/core";
import { DeepgramVoiceRuntime } from "./providers/deepgram.js";
import { ElevenLabsVoiceRuntime } from "./providers/elevenlabs.js";
import { LiveKitVoiceRuntime } from "./providers/livekit.js";
import { TwilioVoiceRuntime } from "./providers/twilio.js";
import { SileroVadRuntime } from "./providers/vad.js";

export interface VoiceRuntime {
	publicBaseUrl?: string;
	livekit: LiveKitVoiceRuntime;
	twilio: TwilioVoiceRuntime;
	deepgram: DeepgramVoiceRuntime;
	elevenlabs: ElevenLabsVoiceRuntime;
	vad: SileroVadRuntime;
}

function resolvePublicBaseUrl(): string | undefined {
	const value = process.env.RANDAL_VOICE_PUBLIC_URL ?? process.env.RANDAL_PUBLIC_URL;
	if (!value) return undefined;
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function createVoiceRuntime(config: RandalConfig): VoiceRuntime {
	return {
		publicBaseUrl: resolvePublicBaseUrl(),
		livekit: new LiveKitVoiceRuntime(config),
		twilio: new TwilioVoiceRuntime(config),
		deepgram: new DeepgramVoiceRuntime(config),
		elevenlabs: new ElevenLabsVoiceRuntime(config),
		vad: new SileroVadRuntime(),
	};
}
