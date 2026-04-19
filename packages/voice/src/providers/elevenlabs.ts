import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { RandalConfig } from "@randal/core";

const FALLBACK_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

export class ElevenLabsVoiceRuntime {
	readonly client: ElevenLabsClient;

	constructor(private config: RandalConfig) {
		this.client = new ElevenLabsClient({ apiKey: config.voice.tts.apiKey });
	}

	resolveVoiceId(): string {
		return this.config.voice.tts.voice ?? FALLBACK_ELEVENLABS_VOICE_ID;
	}

	async streamSpeech(text: string): Promise<ReadableStream<Uint8Array>> {
		return this.client.textToSpeech.stream(this.resolveVoiceId(), {
			text,
			modelId: "eleven_flash_v2_5",
			outputFormat: "ulaw_8000",
		});
	}
}

export { FALLBACK_ELEVENLABS_VOICE_ID };
