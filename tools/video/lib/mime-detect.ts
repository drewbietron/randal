/**
 * MIME detection utility — re-exports from @randal/image-gen-tool.
 *
 * The actual implementation lives in tools/image-gen/.
 * This re-export maintains backward compatibility for video tool code.
 */
export {
	detectMimeType,
	mimeToExtension,
	extensionToMime,
	ensureCorrectExtension,
	type MimeDetectionResult,
} from "@randal/image-gen-tool";
