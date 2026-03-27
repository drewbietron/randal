/**
 * Image generation tool library — barrel export.
 */

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

export {
	generateImage,
	ImageGenerationError,
	type ImageGenerationOptions,
	type ImageGenerationResult,
	type ImageGenerationErrorCode,
} from "./image-gen";

// ---------------------------------------------------------------------------
// MIME detection
// ---------------------------------------------------------------------------

export {
	detectMimeType,
	mimeToExtension,
	extensionToMime,
	ensureCorrectExtension,
	type MimeDetectionResult,
} from "./mime-detect";

// ---------------------------------------------------------------------------
// Provider architecture
// ---------------------------------------------------------------------------

export type {
	GenerateImageOptions,
	GenerateImageResult,
	ImageProvider,
	AnalyzeImageOptions,
	AnalyzeImageResult,
} from "./providers";

export {
	ImageProviderError,
	OpenRouterImageProvider,
	OpenRouterImageError,
	type OpenRouterImageErrorCode,
	registerImageProvider,
	getImageProvider,
	listImageProviders,
} from "./providers";

// ---------------------------------------------------------------------------
// Image analysis
// ---------------------------------------------------------------------------

export {
	analyzeImage,
	ImageAnalysisError,
	type ImageAnalysisErrorCode,
} from "./image-analyze";
