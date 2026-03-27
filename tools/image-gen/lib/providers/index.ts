/**
 * Image providers — barrel export.
 */

// Types
export type {
	GenerateImageOptions,
	GenerateImageResult,
	ImageProvider,
	AnalyzeImageOptions,
	AnalyzeImageResult,
} from "./types";

export { ImageProviderError } from "./types";

// OpenRouter provider
export {
	OpenRouterImageProvider,
	OpenRouterImageError,
	type OpenRouterImageErrorCode,
} from "./openrouter-image";

// Registry
export {
	registerImageProvider,
	getImageProvider,
	listImageProviders,
} from "./image-registry";
