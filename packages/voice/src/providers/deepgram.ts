import {
	type DeepgramClient,
	type ListenLiveClient,
	LiveTranscriptionEvents,
	createClient,
} from "@deepgram/sdk";
import type { RandalConfig } from "@randal/core";

export { LiveTranscriptionEvents };

export interface CreateTranscriptionStreamOptions {
	model?: string;
	encoding?: "mulaw" | "linear16";
	sampleRate?: number;
	interimResults?: boolean;
	endpointing?: number | false;
}

export class DeepgramVoiceRuntime {
	readonly client: DeepgramClient;

	constructor(private config: RandalConfig) {
		this.client = createClient(config.voice.stt.apiKey);
	}

	createTranscriptionStream(options: CreateTranscriptionStreamOptions = {}): ListenLiveClient {
		return this.client.listen.live({
			model: options.model ?? this.config.voice.stt.model ?? "nova-3",
			encoding: options.encoding ?? "mulaw",
			sample_rate: options.sampleRate ?? 8000,
			interim_results: options.interimResults ?? true,
			endpointing: options.endpointing ?? 250,
			punctuate: true,
			smart_format: true,
		});
	}
}
