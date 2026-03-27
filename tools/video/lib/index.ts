/**
 * Video tool library — barrel export.
 */

export {
	generateImage,
	ImageGenerationError,
	type ImageGenerationOptions,
	type ImageGenerationResult,
	type ImageGenerationErrorCode,
} from "./image-gen";

export {
	generateVideoClip,
	checkOperationStatus,
	VideoGenerationError,
	type VideoGenerationOptions,
	type VideoGenerationResult,
	type VideoGenerationErrorCode,
	type VeoAspectRatio,
	type VeoDuration,
	type VeoModel,
} from "./video-gen";

export {
	stitchClips,
	StitchError,
	type StitchOptions,
	type StitchErrorCode,
} from "./stitch";

export {
	renderVideo,
	RenderError,
	type RenderOptions,
	type RenderErrorCode,
} from "./renderer";

// MIME detection
export {
	detectMimeType,
	mimeToExtension,
	extensionToMime,
	ensureCorrectExtension,
	type MimeDetectionResult,
} from "./mime-detect";

// Audio generation
export {
	generateSpeech,
	generateMusic,
	mixAudioTracks,
	attachAudioToVideo,
	AudioGenError,
	type AudioGenOptions,
	type AudioGenErrorCode,
	type MixTrack,
} from "./audio-gen";

// Video reference processing
export {
	extractFrames,
	analyzeVideoWithVision,
	prepareVideoReference,
	VideoRefError,
	type ExtractFramesOptions,
	type ExtractedFrame,
	type AnalyzeVideoOptions,
	type VideoAnalysis,
	type PrepareReferenceOptions,
	type PreparedReference,
	type VideoRefErrorCode,
} from "./video-ref";

// Provider architecture
export type {
	AspectRatio,
	ClipDuration,
	VideoProviderConfig,
	GenerateClipOptions,
	GenerateClipResult,
	VideoProvider,
} from "./providers";

export {
	VideoProviderError,
	VeoProvider,
	MockProvider,
	registerProvider,
	getProvider,
	listProviders,
} from "./providers";
