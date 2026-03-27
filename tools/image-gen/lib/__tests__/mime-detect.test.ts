import { describe, expect, test } from "bun:test";
import {
	detectMimeType,
	ensureCorrectExtension,
	extensionToMime,
	mimeToExtension,
} from "../mime-detect";

// ---------------------------------------------------------------------------
// Helpers — build minimal buffers with the correct magic bytes
// ---------------------------------------------------------------------------

/** JPEG: FF D8 FF E0 (JFIF marker) + padding */
function jpegJfifBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf[0] = 0xff;
	buf[1] = 0xd8;
	buf[2] = 0xff;
	buf[3] = 0xe0;
	// "JFIF" at offset 6
	buf.write("JFIF", 6, "ascii");
	return buf;
}

/** JPEG: FF D8 FF E1 (EXIF marker) + padding */
function jpegExifBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf[0] = 0xff;
	buf[1] = 0xd8;
	buf[2] = 0xff;
	buf[3] = 0xe1;
	// "Exif" at offset 6
	buf.write("Exif", 6, "ascii");
	return buf;
}

/** PNG: full 8-byte signature + padding */
function pngBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < sig.length; i++) buf[i] = sig[i];
	return buf;
}

/** WebP: RIFF + size + WEBP + padding */
function webpBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf.write("RIFF", 0, "ascii"); // bytes 0-3
	// bytes 4-7: file size (dummy)
	buf.writeUInt32LE(100, 4);
	buf.write("WEBP", 8, "ascii"); // bytes 8-11
	return buf;
}

/** RIFF container that is NOT WebP (e.g. WAV) */
function riffNonWebpBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(100, 4);
	buf.write("WAVE", 8, "ascii"); // Not WEBP
	return buf;
}

/** GIF87a */
function gif87aBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf.write("GIF87a", 0, "ascii");
	return buf;
}

/** GIF89a */
function gif89aBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf.write("GIF89a", 0, "ascii");
	return buf;
}

/** BMP: 42 4D ("BM") + padding */
function bmpBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf[0] = 0x42;
	buf[1] = 0x4d;
	return buf;
}

/** TIFF little-endian: 49 49 2A 00 */
function tiffLeBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf[0] = 0x49;
	buf[1] = 0x49;
	buf[2] = 0x2a;
	buf[3] = 0x00;
	return buf;
}

/** TIFF big-endian: 4D 4D 00 2A */
function tiffBeBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf[0] = 0x4d;
	buf[1] = 0x4d;
	buf[2] = 0x00;
	buf[3] = 0x2a;
	return buf;
}

/** AVIF: ftyp box with "avif" brand */
function avifBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	// bytes 0-3: box size (big-endian uint32)
	buf.writeUInt32BE(32, 0);
	// bytes 4-7: "ftyp"
	buf.write("ftyp", 4, "ascii");
	// bytes 8-11: major brand "avif"
	buf.write("avif", 8, "ascii");
	return buf;
}

/** AVIF: ftyp box with "avis" brand (AVIF sequence) */
function avisBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf.writeUInt32BE(32, 0);
	buf.write("ftyp", 4, "ascii");
	buf.write("avis", 8, "ascii");
	return buf;
}

/** ftyp box with non-AVIF brand (e.g. MP4 "isom") */
function ftypNonAvifBuffer(): Buffer {
	const buf = Buffer.alloc(200, 0x00);
	buf.writeUInt32BE(32, 0);
	buf.write("ftyp", 4, "ascii");
	buf.write("isom", 8, "ascii"); // MP4, not AVIF
	return buf;
}

// ---------------------------------------------------------------------------
// Tests: detectMimeType
// ---------------------------------------------------------------------------

describe("detectMimeType", () => {
	// JPEG
	test("detects JPEG from JFIF marker (FF D8 FF E0)", () => {
		const result = detectMimeType(jpegJfifBuffer());
		expect(result.mimeType).toBe("image/jpeg");
		expect(result.extension).toBe("jpg");
	});

	test("detects JPEG from EXIF marker (FF D8 FF E1)", () => {
		const result = detectMimeType(jpegExifBuffer());
		expect(result.mimeType).toBe("image/jpeg");
		expect(result.extension).toBe("jpg");
	});

	// PNG
	test("detects PNG from full 8-byte signature", () => {
		const result = detectMimeType(pngBuffer());
		expect(result.mimeType).toBe("image/png");
		expect(result.extension).toBe("png");
	});

	// WebP
	test("detects WebP (RIFF + WEBP secondary check)", () => {
		const result = detectMimeType(webpBuffer());
		expect(result.mimeType).toBe("image/webp");
		expect(result.extension).toBe("webp");
	});

	test("does not detect RIFF non-WebP as WebP", () => {
		const result = detectMimeType(riffNonWebpBuffer());
		// Should fall through — RIFF without WEBP secondary should not match WebP
		expect(result.mimeType).not.toBe("image/webp");
	});

	// GIF
	test("detects GIF87a", () => {
		const result = detectMimeType(gif87aBuffer());
		expect(result.mimeType).toBe("image/gif");
		expect(result.extension).toBe("gif");
	});

	test("detects GIF89a", () => {
		const result = detectMimeType(gif89aBuffer());
		expect(result.mimeType).toBe("image/gif");
		expect(result.extension).toBe("gif");
	});

	// BMP
	test("detects BMP", () => {
		const result = detectMimeType(bmpBuffer());
		expect(result.mimeType).toBe("image/bmp");
		expect(result.extension).toBe("bmp");
	});

	// TIFF
	test("detects TIFF little-endian (49 49 2A 00)", () => {
		const result = detectMimeType(tiffLeBuffer());
		expect(result.mimeType).toBe("image/tiff");
		expect(result.extension).toBe("tiff");
	});

	test("detects TIFF big-endian (4D 4D 00 2A)", () => {
		const result = detectMimeType(tiffBeBuffer());
		expect(result.mimeType).toBe("image/tiff");
		expect(result.extension).toBe("tiff");
	});

	// AVIF
	test("detects AVIF (ftyp + avif brand)", () => {
		const result = detectMimeType(avifBuffer());
		expect(result.mimeType).toBe("image/avif");
		expect(result.extension).toBe("avif");
	});

	test("detects AVIF (ftyp + avis brand)", () => {
		const result = detectMimeType(avisBuffer());
		expect(result.mimeType).toBe("image/avif");
		expect(result.extension).toBe("avif");
	});

	test("does not detect ftyp with non-AVIF brand as AVIF", () => {
		const result = detectMimeType(ftypNonAvifBuffer());
		expect(result.mimeType).not.toBe("image/avif");
	});

	// Fallback scenarios
	test("falls back to application/octet-stream for empty buffer", () => {
		const result = detectMimeType(Buffer.alloc(0));
		expect(result.mimeType).toBe("application/octet-stream");
		expect(result.extension).toBe("bin");
	});

	test("falls back to application/octet-stream for 1-byte buffer", () => {
		const result = detectMimeType(Buffer.from([0x00]));
		expect(result.mimeType).toBe("application/octet-stream");
		expect(result.extension).toBe("bin");
	});

	test("falls back to application/octet-stream for unknown magic bytes", () => {
		const result = detectMimeType(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
		expect(result.mimeType).toBe("application/octet-stream");
		expect(result.extension).toBe("bin");
	});

	test("uses fallbackMimeType when provided and detection fails", () => {
		const result = detectMimeType(Buffer.alloc(0), "image/png");
		expect(result.mimeType).toBe("image/png");
		expect(result.extension).toBe("png");
	});

	test("uses fallbackMimeType for unknown bytes", () => {
		const result = detectMimeType(Buffer.from([0x01, 0x02, 0x03, 0x04]), "image/jpeg");
		expect(result.mimeType).toBe("image/jpeg");
		expect(result.extension).toBe("jpg");
	});

	test("ignores fallbackMimeType when detection succeeds", () => {
		const result = detectMimeType(pngBuffer(), "image/jpeg");
		expect(result.mimeType).toBe("image/png");
		expect(result.extension).toBe("png");
	});
});

// ---------------------------------------------------------------------------
// Tests: mimeToExtension
// ---------------------------------------------------------------------------

describe("mimeToExtension", () => {
	test("image/jpeg -> jpg", () => {
		expect(mimeToExtension("image/jpeg")).toBe("jpg");
	});

	test("image/png -> png", () => {
		expect(mimeToExtension("image/png")).toBe("png");
	});

	test("image/webp -> webp", () => {
		expect(mimeToExtension("image/webp")).toBe("webp");
	});

	test("image/gif -> gif", () => {
		expect(mimeToExtension("image/gif")).toBe("gif");
	});

	test("image/bmp -> bmp", () => {
		expect(mimeToExtension("image/bmp")).toBe("bmp");
	});

	test("image/tiff -> tiff", () => {
		expect(mimeToExtension("image/tiff")).toBe("tiff");
	});

	test("image/avif -> avif", () => {
		expect(mimeToExtension("image/avif")).toBe("avif");
	});

	test("unknown MIME -> bin", () => {
		expect(mimeToExtension("application/octet-stream")).toBe("bin");
	});

	test("completely unknown MIME -> bin", () => {
		expect(mimeToExtension("video/mp4")).toBe("bin");
	});
});

// ---------------------------------------------------------------------------
// Tests: extensionToMime
// ---------------------------------------------------------------------------

describe("extensionToMime", () => {
	test("jpg -> image/jpeg", () => {
		expect(extensionToMime("jpg")).toBe("image/jpeg");
	});

	test("jpeg -> image/jpeg (alias)", () => {
		expect(extensionToMime("jpeg")).toBe("image/jpeg");
	});

	test(".jpeg -> image/jpeg (with dot)", () => {
		expect(extensionToMime(".jpeg")).toBe("image/jpeg");
	});

	test("png -> image/png", () => {
		expect(extensionToMime("png")).toBe("image/png");
	});

	test("webp -> image/webp", () => {
		expect(extensionToMime("webp")).toBe("image/webp");
	});

	test("gif -> image/gif", () => {
		expect(extensionToMime("gif")).toBe("image/gif");
	});

	test("bmp -> image/bmp", () => {
		expect(extensionToMime("bmp")).toBe("image/bmp");
	});

	test("tiff -> image/tiff", () => {
		expect(extensionToMime("tiff")).toBe("image/tiff");
	});

	test("tif -> image/tiff (alias)", () => {
		expect(extensionToMime("tif")).toBe("image/tiff");
	});

	test(".tif -> image/tiff (alias with dot)", () => {
		expect(extensionToMime(".tif")).toBe("image/tiff");
	});

	test("avif -> image/avif", () => {
		expect(extensionToMime("avif")).toBe("image/avif");
	});

	test("unknown extension -> application/octet-stream", () => {
		expect(extensionToMime("xyz")).toBe("application/octet-stream");
	});

	test("handles uppercase extension", () => {
		expect(extensionToMime("PNG")).toBe("image/png");
	});

	test("handles mixed case with dot", () => {
		expect(extensionToMime(".JpEg")).toBe("image/jpeg");
	});
});

// ---------------------------------------------------------------------------
// Tests: ensureCorrectExtension
// ---------------------------------------------------------------------------

describe("ensureCorrectExtension", () => {
	test("replaces .png with .jpg when content is JPEG", () => {
		const result = ensureCorrectExtension("scene1.png", "image/jpeg");
		expect(result).toBe("scene1.jpg");
	});

	test("replaces .jpg with .png when content is PNG", () => {
		const result = ensureCorrectExtension("photo.jpg", "image/png");
		expect(result).toBe("photo.png");
	});

	test("adds correct extension when filename has none", () => {
		const result = ensureCorrectExtension("output", "image/png");
		expect(result).toBe("output.png");
	});

	test("adds .jpg when filename has no extension and content is JPEG", () => {
		const result = ensureCorrectExtension("photo", "image/jpeg");
		expect(result).toBe("photo.jpg");
	});

	test("leaves filename unchanged when extension matches", () => {
		const result = ensureCorrectExtension("image.png", "image/png");
		expect(result).toBe("image.png");
	});

	test("leaves .jpeg unchanged when content is JPEG (jpeg/jpg equivalence)", () => {
		const result = ensureCorrectExtension("photo.jpeg", "image/jpeg");
		expect(result).toBe("photo.jpeg");
	});

	test("leaves .jpg unchanged when content is JPEG", () => {
		const result = ensureCorrectExtension("photo.jpg", "image/jpeg");
		expect(result).toBe("photo.jpg");
	});

	test("leaves .tif unchanged when content is TIFF (tif/tiff equivalence)", () => {
		const result = ensureCorrectExtension("scan.tif", "image/tiff");
		expect(result).toBe("scan.tif");
	});

	test("leaves .tiff unchanged when content is TIFF", () => {
		const result = ensureCorrectExtension("scan.tiff", "image/tiff");
		expect(result).toBe("scan.tiff");
	});

	test("does not change filename for unknown MIME type", () => {
		const result = ensureCorrectExtension("file.dat", "application/octet-stream");
		expect(result).toBe("file.dat");
	});

	test("handles filename with multiple dots", () => {
		const result = ensureCorrectExtension("my.photo.scene.png", "image/jpeg");
		expect(result).toBe("my.photo.scene.jpg");
	});

	test("handles filename with path-like structure", () => {
		const result = ensureCorrectExtension("output/scene1.png", "image/jpeg");
		expect(result).toBe("output/scene1.jpg");
	});
});
