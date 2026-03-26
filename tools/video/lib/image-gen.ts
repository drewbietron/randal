/**
 * Image generation module — generates still images via the image provider registry.
 *
 * This module is a thin wrapper around the image provider registry.
 * The actual API logic lives in provider implementations (e.g. openrouter-image.ts).
 *
 * Maintains backward-compatible public API: generateImage(), ImageGenerationError,
 * and all associated types.
 *
 * Environment: OPENROUTER_API_KEY (for the default OpenRouter provider)
 */

import { getImageProvider } from "./providers/image-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageGenerationOptions {
	/** Desired width in pixels. Not all models honour this; treated as a hint. */
	width?: number;
	/** Desired height in pixels. Not all models honour this; treated as a hint. */
	height?: number;
	/** Style modifier appended to the prompt (e.g. "photorealistic", "watercolor"). */
	style?: string;
	/** Override the default model. */
	model?: string;
	/** Override the API base URL (for testing). */
	apiBaseUrl?: string;
	/** Select a specific image provider by name. */
	provider?: string;
}

export interface ImageGenerationResult {
	/** The raw image data. */
	buffer: Buffer;
	/** MIME type of the generated image (e.g. "image/png"). */
	mimeType: string;
	/** The model that was actually used (from the response). */
	model: string;
	/** The prompt that was sent (including style modifier). */
	prompt: string;
}

/** Structured error for image generation failures. */
export class ImageGenerationError extends Error {
	constructor(
		message: string,
		public readonly code: ImageGenerationErrorCode,
		public readonly statusCode?: number,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "ImageGenerationError";
	}
}

export type ImageGenerationErrorCode =
	| "MISSING_API_KEY"
	| "RATE_LIMITED"
	| "CONTENT_POLICY"
	| "INVALID_RESPONSE"
	| "NETWORK_ERROR"
	| "API_ERROR"
	| "NO_IMAGE_IN_RESPONSE";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an image from a text prompt using the configured image provider.
 *
 * @param prompt - The text description of the image to generate.
 * @param options - Optional configuration (dimensions, style, model override).
 * @returns The generated image as a Buffer with metadata.
 *
 * @throws {ImageGenerationError} On missing API key, rate limits, content policy
 *   violations, network errors, or invalid responses.
 *
 * @example
 * ```ts
 * const result = await generateImage("A sunset over the ocean with sailboats");
 * await fs.writeFile("sunset.png", result.buffer);
 * ```
 */
export async function generateImage(
	prompt: string,
	options: ImageGenerationOptions = {},
): Promise<ImageGenerationResult> {
	// Validate inputs
	if (!prompt || prompt.trim() === "") {
		throw new ImageGenerationError("Prompt must be a non-empty string.", "API_ERROR");
	}

	try {
		const provider = getImageProvider(options.provider);
		const result = await provider.generateImage(prompt, {
			width: options.width,
			height: options.height,
			style: options.style,
			model: options.model,
			providerOptions: {
				...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
			},
		});

		return {
			buffer: result.buffer,
			mimeType: result.mimeType,
			model: result.model,
			prompt: result.prompt,
		};
	} catch (error) {
		// Already an ImageGenerationError — rethrow directly
		if (error instanceof ImageGenerationError) throw error;

		// Wrap provider errors as ImageGenerationError for backward compat
		if (error instanceof Error) {
			const msg = error.message;
			const statusCode = (error as { statusCode?: number }).statusCode;
			const cause = (error as { cause?: unknown }).cause;

			// Map known error codes from provider errors
			const code = (error as { code?: string }).code;
			if (code) {
				// Registry "no configured provider" maps to MISSING_API_KEY for backward compat
				if (code === "NO_CONFIGURED_PROVIDER") {
					throw new ImageGenerationError(
						"OPENROUTER_API_KEY environment variable is not set or empty.",
						"MISSING_API_KEY",
						statusCode,
						cause,
					);
				}

				// Provider error codes match ImageGenerationErrorCode strings
				const knownCodes: ImageGenerationErrorCode[] = [
					"MISSING_API_KEY",
					"RATE_LIMITED",
					"CONTENT_POLICY",
					"INVALID_RESPONSE",
					"NETWORK_ERROR",
					"API_ERROR",
					"NO_IMAGE_IN_RESPONSE",
				];
				if (knownCodes.includes(code as ImageGenerationErrorCode)) {
					throw new ImageGenerationError(
						msg,
						code as ImageGenerationErrorCode,
						statusCode,
						cause,
					);
				}
			}

			// Map known error patterns from message content
			if (msg.includes("API key") || msg.includes("MISSING_API_KEY")) {
				throw new ImageGenerationError(msg, "MISSING_API_KEY", statusCode, cause);
			}
			if (msg.includes("rate limit") || msg.includes("429")) {
				throw new ImageGenerationError(msg, "RATE_LIMITED", statusCode, cause);
			}
			if (msg.includes("safety") || msg.includes("content policy")) {
				throw new ImageGenerationError(msg, "CONTENT_POLICY", statusCode, cause);
			}

			throw new ImageGenerationError(msg, "API_ERROR", statusCode, cause);
		}

		throw new ImageGenerationError(String(error), "API_ERROR");
	}
}
