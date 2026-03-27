/**
 * Video providers — barrel export.
 */

// ---------------------------------------------------------------------------
// Video provider types + registry
// ---------------------------------------------------------------------------

export type {
	AspectRatio,
	ClipDuration,
	VideoProviderConfig,
	GenerateClipOptions,
	GenerateClipResult,
	VideoProvider,
} from "./types";

export { VideoProviderError } from "./types";

export { VeoProvider, type VeoModel } from "./veo";
export { MockProvider } from "./mock";

export {
	registerProvider,
	getProvider,
	listProviders,
} from "./registry";

// ---------------------------------------------------------------------------
// Image provider types + registry — re-exported from @randal/image-gen-tool
// ---------------------------------------------------------------------------

export type { GenerateImageOptions, GenerateImageResult, ImageProvider } from "./types";

// Re-export image provider registry from @randal/image-gen-tool
export {
	registerImageProvider,
	getImageProvider,
	listImageProviders,
} from "@randal/image-gen-tool";

// ---------------------------------------------------------------------------
// Audio provider types + registry
// ---------------------------------------------------------------------------

export type {
	AudioFormat,
	GenerateSpeechOptions,
	GenerateSpeechResult,
	GenerateMusicOptions,
	GenerateMusicResult,
	AudioProvider,
} from "./types";
export { ElevenLabsProvider } from "./elevenlabs";
export { OpenRouterTTSProvider } from "./openrouter-tts";
export { registerAudioProvider, getAudioProvider, listAudioProviders } from "./audio-registry";
