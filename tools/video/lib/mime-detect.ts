/**
 * Magic byte MIME detection utility.
 *
 * Detects actual image format from buffer bytes instead of trusting API metadata.
 * No dependencies — pure buffer inspection.
 *
 * Supported formats: JPEG, PNG, WebP, GIF, BMP, TIFF, AVIF
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MimeDetectionResult {
	/** The detected MIME type (e.g. "image/jpeg"). */
	mimeType: string;
	/** The canonical file extension (e.g. "jpg"). */
	extension: string;
}

// ---------------------------------------------------------------------------
// Magic byte signatures
// ---------------------------------------------------------------------------

/**
 * Each entry defines a magic byte signature with optional secondary validation.
 * Order matters — more specific checks should come first.
 */
interface MagicSignature {
	/** Bytes to match at the start of the buffer. */
	bytes: number[];
	/** Offset at which to match (default 0). */
	offset?: number;
	/** MIME type for this signature. */
	mimeType: string;
	/** Canonical file extension (without dot). */
	extension: string;
	/**
	 * Optional secondary validation function.
	 * Called after the primary byte match succeeds.
	 * Return false to reject and continue to the next signature.
	 */
	validate?: (buffer: Buffer) => boolean;
}

const SIGNATURES: MagicSignature[] = [
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	{
		bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		mimeType: "image/png",
		extension: "png",
	},

	// JPEG: FF D8 FF
	{
		bytes: [0xff, 0xd8, 0xff],
		mimeType: "image/jpeg",
		extension: "jpg",
	},

	// WebP: RIFF at offset 0, WEBP at offset 8
	{
		bytes: [0x52, 0x49, 0x46, 0x46], // "RIFF"
		mimeType: "image/webp",
		extension: "webp",
		validate: (buffer: Buffer) => {
			if (buffer.length < 12) return false;
			// Bytes 8-11 must be "WEBP"
			return (
				buffer[8] === 0x57 && // W
				buffer[9] === 0x45 && // E
				buffer[10] === 0x42 && // B
				buffer[11] === 0x50 // P
			);
		},
	},

	// GIF87a
	{
		bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // "GIF87a"
		mimeType: "image/gif",
		extension: "gif",
	},

	// GIF89a
	{
		bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // "GIF89a"
		mimeType: "image/gif",
		extension: "gif",
	},

	// BMP: 42 4D ("BM")
	{
		bytes: [0x42, 0x4d],
		mimeType: "image/bmp",
		extension: "bmp",
	},

	// TIFF little-endian: 49 49 2A 00
	{
		bytes: [0x49, 0x49, 0x2a, 0x00],
		mimeType: "image/tiff",
		extension: "tiff",
	},

	// TIFF big-endian: 4D 4D 00 2A
	{
		bytes: [0x4d, 0x4d, 0x00, 0x2a],
		mimeType: "image/tiff",
		extension: "tiff",
	},

	// AVIF: ftyp box — the ftyp box starts at offset 4 with "ftyp", then brand at offset 8
	// We check bytes 4-7 for "ftyp" and bytes 8-11 for "avif" or "avis"
	{
		bytes: [0x66, 0x74, 0x79, 0x70], // "ftyp" at offset 4
		offset: 4,
		mimeType: "image/avif",
		extension: "avif",
		validate: (buffer: Buffer) => {
			if (buffer.length < 12) return false;
			// Brand at offset 8: "avif" or "avis"
			const brand = buffer.slice(8, 12).toString("ascii");
			return brand === "avif" || brand === "avis";
		},
	},
];

// ---------------------------------------------------------------------------
// MIME <-> Extension maps
// ---------------------------------------------------------------------------

const MIME_TO_EXTENSION: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
	"image/avif": "avif",
};

const EXTENSION_TO_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
	avif: "image/avif",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the MIME type of an image buffer using magic byte signatures.
 *
 * @param buffer - The image data buffer to inspect.
 * @param fallbackMimeType - Optional MIME type to use if detection fails.
 *   Defaults to "application/octet-stream".
 * @returns The detected MIME type and canonical file extension.
 */
export function detectMimeType(
	buffer: Buffer,
	fallbackMimeType?: string,
): MimeDetectionResult {
	if (buffer.length < 2) {
		return resolveFromMime(fallbackMimeType ?? "application/octet-stream");
	}

	for (const sig of SIGNATURES) {
		const offset = sig.offset ?? 0;

		// Buffer must be long enough to contain the signature
		if (buffer.length < offset + sig.bytes.length) continue;

		// Check primary bytes
		let match = true;
		for (let i = 0; i < sig.bytes.length; i++) {
			if (buffer[offset + i] !== sig.bytes[i]) {
				match = false;
				break;
			}
		}

		if (!match) continue;

		// Run secondary validation if present
		if (sig.validate && !sig.validate(buffer)) continue;

		return { mimeType: sig.mimeType, extension: sig.extension };
	}

	// No signature matched — use fallback
	return resolveFromMime(fallbackMimeType ?? "application/octet-stream");
}

/**
 * Convert a MIME type to its canonical file extension.
 *
 * @param mimeType - The MIME type (e.g. "image/jpeg").
 * @returns The file extension without a dot (e.g. "jpg"), or "bin" for unknown types.
 */
export function mimeToExtension(mimeType: string): string {
	return MIME_TO_EXTENSION[mimeType] ?? "bin";
}

/**
 * Convert a file extension to its MIME type.
 *
 * @param ext - The file extension, with or without a leading dot (e.g. ".jpg" or "jpg").
 * @returns The MIME type (e.g. "image/jpeg"), or "application/octet-stream" for unknown extensions.
 */
export function extensionToMime(ext: string): string {
	const normalized = ext.replace(/^\./, "").toLowerCase();
	return EXTENSION_TO_MIME[normalized] ?? "application/octet-stream";
}

/**
 * Ensure a filename has the correct file extension for the given MIME type.
 *
 * If the filename already has the correct extension (accounting for aliases
 * like .jpeg/.jpg), it is returned unchanged. Otherwise, the extension is
 * replaced (or added if missing).
 *
 * @param filename - The filename to check/fix.
 * @param mimeType - The actual MIME type of the file content.
 * @returns The filename with the correct extension.
 */
export function ensureCorrectExtension(filename: string, mimeType: string): string {
	const correctExt = mimeToExtension(mimeType);
	if (correctExt === "bin") {
		// Unknown MIME type — don't change the filename
		return filename;
	}

	const dotIdx = filename.lastIndexOf(".");
	if (dotIdx === -1) {
		// No extension — add one
		return `${filename}.${correctExt}`;
	}

	const currentExt = filename.slice(dotIdx + 1).toLowerCase();

	// Check if current extension maps to the same MIME type
	const currentMime = EXTENSION_TO_MIME[currentExt];
	if (currentMime === mimeType) {
		// Extension is already correct (handles jpeg/jpg equivalence, tif/tiff, etc.)
		return filename;
	}

	// Replace incorrect extension
	return `${filename.slice(0, dotIdx)}.${correctExt}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveFromMime(mimeType: string): MimeDetectionResult {
	const extension = MIME_TO_EXTENSION[mimeType] ?? "bin";
	return { mimeType, extension };
}
