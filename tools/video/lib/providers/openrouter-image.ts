/**
 * OpenRouter image generation provider.
 *
 * Wraps the OpenRouter API (OpenAI chat completions format) for image
 * generation using models like Gemini 3.1 Flash Image.
 *
 * Extracted from `image-gen.ts` to implement the `ImageProvider` interface,
 * enabling a provider-registry architecture for image generation.
 *
 * Environment: OPENROUTER_API_KEY
 */

import { detectMimeType } from "../mime-detect";
import type { GenerateImageOptions, GenerateImageResult, ImageProvider } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type OpenRouterImageErrorCode =
	| "MISSING_API_KEY"
	| "RATE_LIMITED"
	| "CONTENT_POLICY"
	| "INVALID_RESPONSE"
	| "NETWORK_ERROR"
	| "API_ERROR"
	| "NO_IMAGE_IN_RESPONSE";

export class OpenRouterImageError extends Error {
	constructor(
		message: string,
		public readonly code: OpenRouterImageErrorCode,
		public readonly statusCode?: number,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "OpenRouterImageError";
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPrompt(basePrompt: string, style?: string): string {
	const parts = ["Generate an image of:", basePrompt.trim()];
	if (style?.trim()) {
		parts.push(`Style: ${style.trim()}`);
	}
	return parts.join(" ");
}

function parseDataUri(uri: string): { buffer: Buffer; mimeType: string } {
	const match = uri.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
	if (!match) {
		throw new OpenRouterImageError(
			`Invalid data URI format: ${uri.slice(0, 50)}...`,
			"INVALID_RESPONSE",
		);
	}
	return {
		buffer: Buffer.from(match[2], "base64"),
		mimeType: match[1],
	};
}

/**
 * Extract base64 image data from the OpenRouter/OpenAI chat completion response.
 *
 * The response may contain image data in several formats:
 * 1. A message.images array with image_url entries (OpenRouter Gemini style)
 * 2. A content part with type "image_url" containing a data URI
 * 3. A content part with inline_data (Gemini-style)
 * 4. A text response containing a base64 block (fallback)
 */
function extractImageFromResponse(responseBody: unknown): {
	buffer: Buffer;
	mimeType: string;
} {
	const body = responseBody as Record<string, unknown>;

	// Navigate to the message content
	const choices = body.choices as Array<Record<string, unknown>> | undefined;
	if (!choices || choices.length === 0) {
		throw new OpenRouterImageError("API response contains no choices.", "INVALID_RESPONSE");
	}

	const message = choices[0].message as Record<string, unknown> | undefined;
	if (!message) {
		throw new OpenRouterImageError("API response choice has no message.", "INVALID_RESPONSE");
	}

	// Case 0: message.images array (OpenRouter Gemini image generation response)
	const images = message.images as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(images) && images.length > 0) {
		for (const img of images) {
			if (img.type === "image_url") {
				const imageUrl = img.image_url as Record<string, unknown> | string | undefined;
				if (typeof imageUrl === "string") {
					const parsed = parseDataUri(imageUrl);
					const detected = detectMimeType(parsed.buffer, parsed.mimeType);
					return { buffer: parsed.buffer, mimeType: detected.mimeType };
				}
				if (imageUrl && typeof (imageUrl as Record<string, unknown>).url === "string") {
					const parsed = parseDataUri((imageUrl as Record<string, unknown>).url as string);
					const detected = detectMimeType(parsed.buffer, parsed.mimeType);
					return { buffer: parsed.buffer, mimeType: detected.mimeType };
				}
			}
		}
	}

	const content = message.content;

	// Case 1: content is an array of parts (multimodal response)
	if (Array.isArray(content)) {
		for (const part of content) {
			const p = part as Record<string, unknown>;

			// OpenAI-style image_url part
			if (p.type === "image_url") {
				const imageUrl = p.image_url as Record<string, unknown> | undefined;
				if (imageUrl?.url && typeof imageUrl?.url === "string") {
					const parsed = parseDataUri(imageUrl.url);
					const detected = detectMimeType(parsed.buffer, parsed.mimeType);
					return { buffer: parsed.buffer, mimeType: detected.mimeType };
				}
			}

			// Gemini-style inline_data part
			if (p.type === "inline_data" || p.inline_data) {
				const inlineData = (p.inline_data ?? p) as Record<string, unknown>;
				if (inlineData.data && typeof inlineData.data === "string") {
					const buffer = Buffer.from(inlineData.data, "base64");
					const fallback =
						typeof inlineData.mime_type === "string" ? inlineData.mime_type : "image/png";
					const detected = detectMimeType(buffer, fallback);
					return { buffer, mimeType: detected.mimeType };
				}
			}
		}
	}

	// Case 2: content is a string — look for a data URI or raw base64
	if (typeof content === "string") {
		// Try data URI first
		const dataUriMatch = content.match(/data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)/);
		if (dataUriMatch) {
			const buffer = Buffer.from(dataUriMatch[2], "base64");
			const detected = detectMimeType(buffer, dataUriMatch[1]);
			return { buffer, mimeType: detected.mimeType };
		}

		// Try raw base64 block (very long base64 string)
		const base64Match = content.match(/([A-Za-z0-9+/=]{100,})/);
		if (base64Match) {
			const buffer = Buffer.from(base64Match[1], "base64");
			const detected = detectMimeType(buffer);
			return { buffer, mimeType: detected.mimeType };
		}
	}

	throw new OpenRouterImageError(
		"No image data found in API response. The model may have returned text only.",
		"NO_IMAGE_IN_RESPONSE",
	);
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

export class OpenRouterImageProvider implements ImageProvider {
	readonly name = "openrouter";
	readonly description = "Image generation via OpenRouter API (Gemini, etc.)";
	readonly models = [
		"google/gemini-3.1-flash-image-preview",
		"google/gemini-2.0-flash-exp:free",
	];

	private readonly apiBaseUrl: string;

	constructor(options?: { apiBaseUrl?: string }) {
		this.apiBaseUrl = options?.apiBaseUrl ?? DEFAULT_API_BASE;
	}

	isConfigured(): boolean {
		const key = process.env.OPENROUTER_API_KEY;
		return typeof key === "string" && key.trim() !== "";
	}

	async generateImage(
		prompt: string,
		options: GenerateImageOptions = {},
	): Promise<GenerateImageResult> {
		if (!prompt || prompt.trim() === "") {
			throw new OpenRouterImageError("Prompt must be a non-empty string.", "API_ERROR");
		}

		const apiKey = this.getApiKey();
		const model = options.model ?? DEFAULT_MODEL;
		const fullPrompt = buildPrompt(prompt, options.style);

		// Build the request body
		const requestBody: Record<string, unknown> = {
			model,
			messages: [
				{
					role: "user",
					content: fullPrompt,
				},
			],
		};

		// Add dimension hints if provided
		if (options.width || options.height) {
			requestBody.generation_config = {
				...(options.width ? { width: options.width } : {}),
				...(options.height ? { height: options.height } : {}),
			};
		}

		// Retry loop
		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const response = await fetch(`${this.apiBaseUrl}/chat/completions`, {
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
						throw new OpenRouterImageError(
							`Rate limited after ${MAX_RETRIES + 1} attempts: ${errorMessage}`,
							"RATE_LIMITED",
							status,
						);
					}

					// Content policy violation — do not retry
					if (status === 400 && errorMessage.toLowerCase().includes("safety")) {
						throw new OpenRouterImageError(
							`Content policy violation: ${errorMessage}`,
							"CONTENT_POLICY",
							status,
						);
					}

					// Other API errors
					throw new OpenRouterImageError(
						`OpenRouter API error: ${errorMessage}`,
						"API_ERROR",
						status,
					);
				}

				const responseBody = await response.json();
				const { buffer, mimeType } = extractImageFromResponse(responseBody);

				// Basic sanity check — image should be more than a few bytes
				if (buffer.length < 100) {
					throw new OpenRouterImageError(
						`Generated image is suspiciously small (${buffer.length} bytes). The model may have failed silently.`,
						"INVALID_RESPONSE",
					);
				}

				return {
					buffer,
					mimeType,
					model,
					prompt: fullPrompt,
				};
			} catch (error) {
				// If it's already our error type, rethrow (unless it's retriable)
				if (error instanceof OpenRouterImageError) {
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

				throw new OpenRouterImageError(
					`Network error after ${MAX_RETRIES + 1} attempts: ${error instanceof Error ? error.message : String(error)}`,
					"NETWORK_ERROR",
					undefined,
					error,
				);
			}
		}

		// Should be unreachable, but TypeScript needs it
		throw new OpenRouterImageError(
			`Failed after ${MAX_RETRIES + 1} attempts.`,
			"NETWORK_ERROR",
			undefined,
			lastError,
		);
	}

	private getApiKey(): string {
		const key = process.env.OPENROUTER_API_KEY;
		if (!key || key.trim() === "") {
			throw new OpenRouterImageError(
				"OPENROUTER_API_KEY environment variable is not set or empty.",
				"MISSING_API_KEY",
			);
		}
		return key.trim();
	}
}
