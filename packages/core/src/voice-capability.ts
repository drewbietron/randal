import type { RandalConfig } from "./config.js";

export interface VoiceCapability {
	available: boolean;
	enabled: boolean;
	hasChannel: boolean;
	reason:
		| "voice disabled"
		| "voice channel not configured"
		| "voice config incomplete"
		| "voice available";
	missing: string[];
	ttsVoiceId?: string;
}

function nonEmpty(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function pushMissing(missing: string[], key: string, value: string | undefined): void {
	if (!nonEmpty(value)) {
		missing.push(key);
	}
}

export function getVoiceCapability(config: RandalConfig): VoiceCapability {
	const hasChannel = config.gateway.channels.some((channel) => channel.type === "voice");
	const enabled = config.voice.enabled;
	const ttsVoiceId = nonEmpty(config.voice.tts.voice) ? config.voice.tts.voice : undefined;

	if (!enabled) {
		return {
			available: false,
			enabled,
			hasChannel,
			reason: "voice disabled",
			missing: [],
			ttsVoiceId,
		};
	}

	if (!hasChannel) {
		return {
			available: false,
			enabled,
			hasChannel,
			reason: "voice channel not configured",
			missing: [],
			ttsVoiceId,
		};
	}

	const missing: string[] = [];
	pushMissing(missing, "voice.livekit.url", config.voice.livekit.url);
	pushMissing(missing, "voice.livekit.apiKey", config.voice.livekit.apiKey);
	pushMissing(missing, "voice.livekit.apiSecret", config.voice.livekit.apiSecret);
	pushMissing(missing, "voice.twilio.accountSid", config.voice.twilio.accountSid);
	pushMissing(missing, "voice.twilio.authToken", config.voice.twilio.authToken);
	pushMissing(missing, "voice.twilio.phoneNumber", config.voice.twilio.phoneNumber);

	if (config.voice.stt.provider === "deepgram" || config.voice.stt.provider === "assemblyai") {
		pushMissing(missing, "voice.stt.apiKey", config.voice.stt.apiKey);
	}

	if (config.voice.tts.provider !== "edge") {
		pushMissing(missing, "voice.tts.apiKey", config.voice.tts.apiKey);
	}

	if (missing.length > 0) {
		return {
			available: false,
			enabled,
			hasChannel,
			reason: "voice config incomplete",
			missing,
			ttsVoiceId,
		};
	}

	return {
		available: true,
		enabled,
		hasChannel,
		reason: "voice available",
		missing,
		ttsVoiceId,
	};
}
