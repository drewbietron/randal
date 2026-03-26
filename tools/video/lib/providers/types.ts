/**
 * Video provider interface — defines the contract any video generation backend must implement.
 *
 * Adding a new provider (SeedDance, Runway, Kling, etc.) means implementing the
 * VideoProvider interface — zero changes to calling code.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type AspectRatio = "16:9" | "9:16";
export type ClipDuration = 4 | 6 | 8;

export interface VideoProviderConfig {
	/** API key or auth token */
	apiKey: string;
	/** Base URL override (for testing) */
	apiBaseUrl?: string;
}

export interface GenerateClipOptions {
	duration?: ClipDuration;
	aspectRatio?: AspectRatio;
	referenceImage?: Buffer;
	referenceImageMimeType?: string;
	resolution?: string;
	sampleCount?: number;
	timeoutMs?: number;
	pollIntervalMs?: number;
	/** Provider-specific options (passed through) */
	providerOptions?: Record<string, unknown>;
}

export interface GenerateClipResult {
	buffer: Buffer;
	mimeType: string;
	model: string;
	prompt: string;
	/** Provider-specific metadata */
	metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface VideoProvider {
	/** Unique provider name (e.g. "veo", "runway", "seeddance") */
	readonly name: string;
	/** Human-readable description */
	readonly description: string;
	/** List of supported models */
	readonly models: string[];

	/** Generate a video clip */
	generateClip(prompt: string, options?: GenerateClipOptions): Promise<GenerateClipResult>;

	/** Check if the provider is configured (has API key, etc.) */
	isConfigured(): boolean;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class VideoProviderError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly provider: string,
		public readonly statusCode?: number,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "VideoProviderError";
	}
}

// ---------------------------------------------------------------------------
// Image provider types
// ---------------------------------------------------------------------------

export interface GenerateImageOptions {
	/** Desired width in pixels (hint — not all providers honour this). */
	width?: number;
	/** Desired height in pixels (hint — not all providers honour this). */
	height?: number;
	/** Style modifier appended to the prompt. */
	style?: string;
	/** Override the default model. */
	model?: string;
	/** Provider-specific options (passed through). */
	providerOptions?: Record<string, unknown>;
}

export interface GenerateImageResult {
	/** The raw image data. */
	buffer: Buffer;
	/** MIME type of the generated image (detected from bytes). */
	mimeType: string;
	/** The model that was actually used. */
	model: string;
	/** The prompt that was sent (including style modifier). */
	prompt: string;
	/** Provider-specific metadata. */
	metadata?: Record<string, unknown>;
}

export interface ImageProvider {
	/** Unique provider name (e.g. "openrouter", "replicate", "dalle") */
	readonly name: string;
	/** Human-readable description */
	readonly description: string;
	/** List of supported models */
	readonly models: string[];

	/** Generate an image from a text prompt */
	generateImage(prompt: string, options?: GenerateImageOptions): Promise<GenerateImageResult>;

	/** Check if the provider is configured (has API key, etc.) */
	isConfigured(): boolean;
}
