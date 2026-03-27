/**
 * ElevenLabs TTS provider — generates speech audio via the ElevenLabs API.
 *
 * HTTP-only implementation (no SDK dependency) for text-to-speech.
 * Does NOT support music generation.
 *
 * Environment: ELEVENLABS_API_KEY
 */

import type {
	AudioFormat,
	AudioProvider,
	GenerateSpeechOptions,
	GenerateSpeechResult,
} from "./types";
import { VideoProviderError } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const DEFAULT_MODEL = "eleven_multilingual_v2";
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Map our AudioFormat to ElevenLabs output_format query parameter values.
 *
 * See: https://elevenlabs.io/docs/api-reference/text-to-speech
 */
const FORMAT_MAP: Record<AudioFormat, string> = {
	mp3: "mp3_44100_128",
	wav: "pcm_16000",
	pcm: "pcm_16000",
	ogg: "mp3_44100_128", // ElevenLabs doesn't natively support ogg — fall back to mp3
	aac: "mp3_44100_128", // Same fallback
	flac: "mp3_44100_128", // Same fallback
};

/**
 * Map our AudioFormat to MIME types for the response.
 */
const FORMAT_MIME: Record<AudioFormat, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	pcm: "audio/pcm",
	ogg: "audio/mpeg", // Fallback format is mp3
	aac: "audio/mpeg",
	flac: "audio/mpeg",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Voice listing helper
// ---------------------------------------------------------------------------

export interface ElevenLabsVoice {
	voice_id: string;
	name: string;
	category: string;
	labels: Record<string, string>;
}

/**
 * List available voices from ElevenLabs.
 * Useful for discovery but not required by the AudioProvider interface.
 */
export async function listVoices(apiKey?: string): Promise<ElevenLabsVoice[]> {
	const key = apiKey ?? process.env.ELEVENLABS_API_KEY;
	if (!key || key.trim() === "") {
		throw new VideoProviderError(
			"ELEVENLABS_API_KEY is not set or empty.",
			"MISSING_API_KEY",
			"elevenlabs",
		);
	}

	const response = await fetch(`${API_BASE}/voices`, {
		method: "GET",
		headers: {
			"xi-api-key": key.trim(),
		},
	});

	if (!response.ok) {
		throw new VideoProviderError(
			`Failed to list voices: HTTP ${response.status} ${response.statusText}`,
			"API_ERROR",
			"elevenlabs",
			response.status,
		);
	}

	const body = (await response.json()) as { voices: ElevenLabsVoice[] };
	return body.voices ?? [];
}

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

export class ElevenLabsProvider implements AudioProvider {
	readonly name = "elevenlabs";
	readonly description = "ElevenLabs — high-quality text-to-speech";
	readonly models = [
		"eleven_multilingual_v2",
		"eleven_turbo_v2_5",
		"eleven_turbo_v2",
		"eleven_monolingual_v1",
	];

	private readonly apiBaseUrl: string;

	constructor(options?: { apiBaseUrl?: string }) {
		this.apiBaseUrl = options?.apiBaseUrl ?? API_BASE;
	}

	isConfigured(): boolean {
		const key = process.env.ELEVENLABS_API_KEY;
		return typeof key === "string" && key.trim() !== "";
	}

	async generateSpeech(
		text: string,
		options: GenerateSpeechOptions = {},
	): Promise<GenerateSpeechResult> {
		if (!text || text.trim() === "") {
			throw new VideoProviderError("Text must be a non-empty string.", "API_ERROR", this.name);
		}

		const apiKey = this.getApiKey();
		const voiceId = options.voice ?? DEFAULT_VOICE_ID;
		const model = options.model ?? DEFAULT_MODEL;
		const format: AudioFormat = options.format ?? "mp3";
		const outputFormat = FORMAT_MAP[format] ?? FORMAT_MAP.mp3;
		const mimeType = FORMAT_MIME[format] ?? FORMAT_MIME.mp3;

		// Build request body
		const requestBody: Record<string, unknown> = {
			text: text.trim(),
			model_id: model,
			voice_settings: {
				stability: 0.5,
				similarity_boost: 0.75,
			},
		};

		// ElevenLabs doesn't have a native "speed" param in the basic API,
		// but some models support it via voice_settings or generation config.
		// We include it in provider options if the caller requests it.
		if (options.providerOptions) {
			Object.assign(requestBody, options.providerOptions);
		}

		// Retry loop
		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const url = `${this.apiBaseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`;

				const response = await fetch(url, {
					method: "POST",
					headers: {
						"xi-api-key": apiKey,
						"Content-Type": "application/json",
						Accept: mimeType === "audio/pcm" ? "audio/pcm" : "audio/mpeg",
					},
					body: JSON.stringify(requestBody),
				});

				// Handle HTTP errors
				if (!response.ok) {
					const status = response.status;
					let errorMessage: string;

					try {
						const errorBody = (await response.json()) as Record<string, unknown>;
						const detail = errorBody.detail as Record<string, unknown> | string | undefined;
						errorMessage =
							typeof detail === "string"
								? detail
								: ((detail?.message as string) ?? JSON.stringify(errorBody));
					} catch {
						errorMessage = `HTTP ${status}: ${response.statusText}`;
					}

					// Rate limiting — retry with backoff
					if (status === 429) {
						if (attempt < MAX_RETRIES) {
							const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
							await sleep(delay);
							continue;
						}
						throw new VideoProviderError(
							`Rate limited after ${MAX_RETRIES + 1} attempts: ${errorMessage}`,
							"RATE_LIMITED",
							this.name,
							status,
						);
					}

					// Auth errors
					if (status === 401) {
						throw new VideoProviderError(
							`Authentication failed: ${errorMessage}`,
							"MISSING_API_KEY",
							this.name,
							status,
						);
					}

					// Other API errors
					throw new VideoProviderError(
						`ElevenLabs API error: ${errorMessage}`,
						"API_ERROR",
						this.name,
						status,
					);
				}

				// Read the raw audio bytes from the response
				const arrayBuffer = await response.arrayBuffer();
				const buffer = Buffer.from(arrayBuffer);

				// Sanity check
				if (buffer.length < 100) {
					throw new VideoProviderError(
						`Generated audio is suspiciously small (${buffer.length} bytes). The API may have failed silently.`,
						"INVALID_RESPONSE",
						this.name,
					);
				}

				return {
					buffer,
					mimeType,
					model,
					metadata: {
						provider: this.name,
						voiceId,
						outputFormat,
						textLength: text.length,
					},
				};
			} catch (error) {
				// If it's already our error type, rethrow (unless retriable)
				if (error instanceof VideoProviderError) {
					if (error.code === "RATE_LIMITED" && attempt < MAX_RETRIES) {
						lastError = error;
						const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
						await sleep(delay);
						continue;
					}
					throw error;
				}

				// Network/fetch errors — retry
				lastError = error;
				if (attempt < MAX_RETRIES) {
					const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
					await sleep(delay);
					continue;
				}

				throw new VideoProviderError(
					`Network error after ${MAX_RETRIES + 1} attempts: ${error instanceof Error ? error.message : String(error)}`,
					"NETWORK_ERROR",
					this.name,
					undefined,
					error,
				);
			}
		}

		// Unreachable, but satisfies TypeScript
		throw new VideoProviderError(
			`Failed after ${MAX_RETRIES + 1} attempts.`,
			"NETWORK_ERROR",
			this.name,
			undefined,
			lastError,
		);
	}

	// generateMusic is NOT supported — ElevenLabs doesn't do music generation.
	// Left undefined per the AudioProvider interface (optional method).

	private getApiKey(): string {
		const key = process.env.ELEVENLABS_API_KEY;
		if (!key || key.trim() === "") {
			throw new VideoProviderError(
				"ELEVENLABS_API_KEY environment variable is not set or empty.",
				"MISSING_API_KEY",
				this.name,
			);
		}
		return key.trim();
	}
}
