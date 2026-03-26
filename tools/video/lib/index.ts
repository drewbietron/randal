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
