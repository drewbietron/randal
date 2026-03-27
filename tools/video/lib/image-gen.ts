/**
 * Image generation module — re-exports from @randal/image-gen-tool.
 *
 * The actual implementation lives in tools/image-gen/.
 * This re-export maintains backward compatibility for video tool code.
 */
export {
	generateImage,
	ImageGenerationError,
	type ImageGenerationOptions,
	type ImageGenerationResult,
	type ImageGenerationErrorCode,
} from "@randal/image-gen-tool";
