/**
 * OpenRouter TTS provider — generates speech audio via OpenRouter's audio/speech endpoint.
 *
 * Proxies OpenAI-compatible TTS models (openai/tts-1, openai/tts-1-hd, etc.)
 * through OpenRouter's API.
 *
 * Does NOT support music generation.
 *
 * Environment: OPENROUTER_API_KEY (shared with image generation)
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

const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/tts-1";
const DEFAULT_VOICE = "alloy";
const DEFAULT_SPEED = 1.0;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Map our AudioFormat to OpenAI response_format values.
 */
const FORMAT_MAP: Record<AudioFormat, string> = {
	mp3: "mp3",
	wav: "wav",
	pcm: "pcm",
	ogg: "opus", // OpenAI uses "opus" for ogg container
	aac: "aac",
	flac: "flac",
};

/**
 * Map our AudioFormat to MIME types.
 */
const FORMAT_MIME: Record<AudioFormat, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	pcm: "audio/pcm",
	ogg: "audio/ogg",
	aac: "audio/aac",
	flac: "audio/flac",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

export class OpenRouterTTSProvider implements AudioProvider {
	readonly name = "openrouter-tts";
	readonly description = "TTS via OpenRouter (OpenAI tts-1, tts-1-hd, etc.)";
	readonly models = ["openai/tts-1", "openai/tts-1-hd"];

	private readonly apiBaseUrl: string;

	constructor(options?: { apiBaseUrl?: string }) {
		this.apiBaseUrl = options?.apiBaseUrl ?? DEFAULT_API_BASE;
	}

	isConfigured(): boolean {
		const key = process.env.OPENROUTER_API_KEY;
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
		const model = options.model ?? DEFAULT_MODEL;
		const voice = options.voice ?? DEFAULT_VOICE;
		const speed = options.speed ?? DEFAULT_SPEED;
		const format: AudioFormat = options.format ?? "mp3";
		const responseFormat = FORMAT_MAP[format] ?? FORMAT_MAP.mp3;
		const mimeType = FORMAT_MIME[format] ?? FORMAT_MIME.mp3;

		// Build request body — OpenAI audio/speech format
		const requestBody: Record<string, unknown> = {
			model,
			input: text.trim(),
			voice,
			response_format: responseFormat,
			speed,
		};

		// Retry loop
		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const response = await fetch(`${this.apiBaseUrl}/audio/speech`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						"HTTP-Referer": "https://github.com/anomalyco/randal",
						"X-Title": "Randal Video Tool",
					},
					body: JSON.stringify(requestBody),
				});

				// Handle HTTP errors
				if (!response.ok) {
					const status = response.status;
					let errorMessage: string;

					try {
						const errorBody = (await response.json()) as Record<string, unknown>;
						const errorObj = errorBody.error as Record<string, unknown> | undefined;
						errorMessage = (errorObj?.message as string) ?? JSON.stringify(errorBody);
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

					// 404 — endpoint may not be available on OpenRouter
					if (status === 404) {
						throw new VideoProviderError(
							`OpenRouter audio/speech endpoint not available. The /audio/speech endpoint may not be supported for model "${model}". Error: ${errorMessage}`,
							"API_ERROR",
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
						`OpenRouter TTS API error: ${errorMessage}`,
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
						voice,
						speed,
						responseFormat,
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

	// generateMusic is NOT supported via OpenRouter TTS.
	// Left undefined per the AudioProvider interface (optional method).

	private getApiKey(): string {
		const key = process.env.OPENROUTER_API_KEY;
		if (!key || key.trim() === "") {
			throw new VideoProviderError(
				"OPENROUTER_API_KEY environment variable is not set or empty.",
				"MISSING_API_KEY",
				this.name,
			);
		}
		return key.trim();
	}
}
