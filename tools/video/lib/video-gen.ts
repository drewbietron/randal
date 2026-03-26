/**
 * Video generation module — public API.
 *
 * This is a thin wrapper around the provider-based architecture.
 * The actual implementation lives in `./providers/veo.ts` (and other providers).
 *
 * The `generateVideoClip()` function signature is backward-compatible with the
 * original Veo-only implementation.
 */

import { getProvider } from "./providers/registry";
import type { GenerateClipOptions, GenerateClipResult } from "./providers/types";
import { VideoProviderError } from "./providers/types";

// ---------------------------------------------------------------------------
// Backward-compatible types
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `GenerateClipOptions` from `./providers/types` instead.
 * Kept for backward compatibility.
 */
export type VeoAspectRatio = "16:9" | "9:16";

/**
 * @deprecated Use `ClipDuration` from `./providers/types` instead.
 * Kept for backward compatibility.
 */
export type VeoDuration = 4 | 6 | 8;

/**
 * @deprecated Use provider-specific model types instead.
 * Kept for backward compatibility.
 */
export type VeoModel = "veo-3.0-generate-001" | "veo-3.1-generate-preview";

/**
 * @deprecated Use `GenerateClipOptions` from `./providers/types` instead.
 * Kept for backward compatibility — maps to the new provider options.
 */
export interface VideoGenerationOptions {
	duration?: VeoDuration;
	aspectRatio?: VeoAspectRatio;
	referenceImage?: Buffer;
	referenceImageMimeType?: string;
	model?: VeoModel;
	resolution?: "720p" | "1080p";
	sampleCount?: number;
	timeoutMs?: number;
	pollIntervalMs?: number;
	apiBaseUrl?: string;
}

/**
 * @deprecated Use `GenerateClipResult` from `./providers/types` instead.
 * Kept for backward compatibility.
 */
export interface VideoGenerationResult {
	buffer: Buffer;
	mimeType: string;
	model: string;
	prompt: string;
	operationName: string;
}

/**
 * @deprecated Use `VideoProviderError` from `./providers/types` instead.
 * Kept for backward compatibility — re-exported as an alias.
 */
export class VideoGenerationError extends Error {
	constructor(
		message: string,
		public readonly code: VideoGenerationErrorCode,
		public readonly statusCode?: number,
		public readonly operationName?: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "VideoGenerationError";
	}
}

export type VideoGenerationErrorCode =
	| "MISSING_API_KEY"
	| "RATE_LIMITED"
	| "CONTENT_POLICY"
	| "INVALID_RESPONSE"
	| "NETWORK_ERROR"
	| "API_ERROR"
	| "TIMEOUT"
	| "OPERATION_FAILED"
	| "NO_VIDEO_IN_RESPONSE";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a video clip from a text prompt.
 *
 * Delegates to the configured video provider (default: first configured provider).
 * Pass `options.provider` to select a specific provider by name.
 *
 * This function is backward-compatible with the original Veo-only signature.
 * The old `VideoGenerationOptions` fields are mapped to `GenerateClipOptions`
 * plus provider-specific options.
 *
 * @param prompt - The text description of the video to generate.
 * @param options - Generation options (duration, aspect ratio, provider, etc.).
 * @returns The generated video as a Buffer with metadata.
 *
 * @example
 * ```ts
 * // Use default provider
 * const result = await generateVideoClip("A drone shot flying over a mountain range at sunset");
 * await fs.writeFile("mountain-flyover.mp4", result.buffer);
 * ```
 *
 * @example
 * ```ts
 * // Select a specific provider
 * const result = await generateVideoClip("Ocean waves at dawn", { provider: "veo" });
 * ```
 *
 * @example
 * ```ts
 * // Image-to-video with a reference image
 * const imageBuffer = await fs.readFile("./first-frame.png");
 * const result = await generateVideoClip("Camera slowly zooms out", {
 *   referenceImage: imageBuffer,
 *   duration: 6,
 *   aspectRatio: "16:9",
 * });
 * ```
 */
export async function generateVideoClip(
	prompt: string,
	options?: (GenerateClipOptions | VideoGenerationOptions) & { provider?: string },
): Promise<GenerateClipResult> {
	const providerName = options?.provider;
	const provider = getProvider(providerName);

	// Map old-style VideoGenerationOptions to GenerateClipOptions
	const clipOptions: GenerateClipOptions = {
		duration: options?.duration,
		aspectRatio: options?.aspectRatio,
		referenceImage: options?.referenceImage,
		referenceImageMimeType: options?.referenceImageMimeType,
		resolution: options?.resolution,
		sampleCount: options?.sampleCount,
		timeoutMs: options?.timeoutMs,
		pollIntervalMs: options?.pollIntervalMs,
	};

	// Pass Veo-specific options through providerOptions
	const legacyOptions = options as VideoGenerationOptions | undefined;
	if (legacyOptions?.model || legacyOptions?.apiBaseUrl) {
		clipOptions.providerOptions = {
			...(legacyOptions.model ? { model: legacyOptions.model } : {}),
			...(legacyOptions.apiBaseUrl ? { apiBaseUrl: legacyOptions.apiBaseUrl } : {}),
		};
	}

	try {
		return await provider.generateClip(prompt, clipOptions);
	} catch (error) {
		// Wrap VideoProviderError as VideoGenerationError for backward compatibility
		if (error instanceof VideoProviderError) {
			throw new VideoGenerationError(
				error.message,
				error.code as VideoGenerationErrorCode,
				error.statusCode,
				(error as unknown as Record<string, unknown>).operationName as string | undefined,
				error.cause,
			);
		}
		throw error;
	}
}

/**
 * Check the status of a previously submitted video generation operation.
 *
 * Note: This is Veo-specific and remains here for backward compatibility.
 * For new code, access the provider directly.
 */
export async function checkOperationStatus(
	operationName: string,
	options: { apiBaseUrl?: string } = {},
): Promise<{
	done: boolean;
	error?: { code: number; message: string };
	metadata?: Record<string, unknown>;
}> {
	const apiKey = process.env.GOOGLE_AI_STUDIO_KEY;
	if (!apiKey || apiKey.trim() === "") {
		throw new VideoGenerationError(
			"GOOGLE_AI_STUDIO_KEY environment variable is not set or empty.",
			"MISSING_API_KEY",
		);
	}

	const apiBase = options.apiBaseUrl ?? "https://generativelanguage.googleapis.com/v1beta";

	const operationPath = operationName.startsWith("operations/")
		? operationName
		: `operations/${operationName}`;
	const url = `${apiBase}/${operationPath}`;

	const response = await fetch(url, {
		method: "GET",
		headers: {
			"x-goog-api-key": apiKey.trim(),
		},
	});

	if (!response.ok) {
		throw new VideoGenerationError(
			`Failed to check operation status: HTTP ${response.status}`,
			"API_ERROR",
			response.status,
			operationName,
		);
	}

	const body = (await response.json()) as {
		done?: boolean;
		error?: { code: number; message: string };
		metadata?: Record<string, unknown>;
	};

	return {
		done: body.done ?? false,
		error: body.error,
		metadata: body.metadata,
	};
}
