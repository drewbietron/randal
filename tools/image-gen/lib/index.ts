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

// ---------------------------------------------------------------------------
// Character consistency
// ---------------------------------------------------------------------------

export {
	// Types & schemas
	CharacterStorageError,
	CharacterEyesSchema,
	CharacterHairSchema,
	CharacterPhysicalSchema,
	// Storage
	getCharacterDir,
	ensureCharacterDir,
	characterPath,
	characterExists,
	saveCharacter,
	loadCharacter,
	listCharacters,
	updateCharacter,
	deleteCharacter,
	// Prompt builder
	mergePhysical,
	buildCIDBlock,
	buildCharacterPrompt,
	buildNegativePrompt,
	buildReferencePrompt,
	// Consistency
	checkConsistency,
	generateWithConsistency,
	parseConsistencyResponse,
	buildComparisonPrompt,
	buildDriftEmphasis,
} from "./characters";

export type {
	CharacterEyes,
	CharacterHair,
	CharacterPhysical,
	CharacterProfile,
	ConsistencyScore,
	GenerateWithCharacterOptions,
	CharacterGenerationResult,
	CharacterErrorCode,
	GenerateWithConsistencyOptions,
} from "./characters";
