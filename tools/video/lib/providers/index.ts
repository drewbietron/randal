/**
 * Video providers — barrel export.
 */

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
