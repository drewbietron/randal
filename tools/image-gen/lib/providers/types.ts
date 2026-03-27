/**
 * Image provider interface — defines the contract any image generation backend must implement.
 *
 * Adding a new provider (DALL-E, Replicate, Stability, etc.) means implementing the
 * ImageProvider interface — zero changes to calling code.
 */

// ---------------------------------------------------------------------------
// Image generation types
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

// ---------------------------------------------------------------------------
// Image analysis types
// ---------------------------------------------------------------------------

export interface AnalyzeImageOptions {
	/** Override the default vision model. */
	model?: string;
	/** Custom system prompt for the analysis. */
	systemPrompt?: string;
	/** Provider-specific options. */
	providerOptions?: Record<string, unknown>;
}

export interface AnalyzeImageResult {
	/** Structured description of the image. */
	description: string;
	/** Objects/subjects detected. */
	objects: string[];
	/** Text found in the image (OCR-like). */
	text: string[];
	/** Dominant colors described. */
	colors: string[];
	/** Visual style description. */
	style: string;
	/** Overall mood/tone. */
	mood: string;
	/** The model used for analysis. */
	model: string;
	/** Raw model response for debugging. */
	rawResponse?: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ImageProviderError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly provider: string,
		public readonly statusCode?: number,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "ImageProviderError";
	}
}
