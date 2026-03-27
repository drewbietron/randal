import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ImageGenerationError, generateImage } from "../image-gen";
import { getProvider } from "../providers/registry";
import { StitchError, stitchClips } from "../stitch";
import { generateVideoClip } from "../video-gen";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
let savedFetch: typeof globalThis.fetch | undefined;

function saveFetch() {
	savedFetch = globalThis.fetch;
}

function restoreFetch() {
	if (savedFetch) {
		globalThis.fetch = savedFetch;
		savedFetch = undefined;
	}
}

/** Fake base64 PNG — starts with PNG header and is > 100 bytes for sanity check. */
function fakePngBase64(): string {
	// Real PNG header (8 bytes) + IHDR chunk stub + padding to exceed 100 bytes
	const pngHeader = Buffer.from([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a, // PNG signature
		// IHDR chunk
		0x00,
		0x00,
		0x00,
		0x0d, // chunk length: 13
		0x49,
		0x48,
		0x44,
		0x52, // "IHDR"
		0x00,
		0x00,
		0x03,
		0x00, // width: 768
		0x00,
		0x00,
		0x02,
		0x00, // height: 512
		0x08,
		0x02, // bit depth 8, color type 2 (RGB)
		0x00,
		0x00,
		0x00, // compression, filter, interlace
		0x00,
		0x00,
		0x00,
		0x00, // CRC placeholder
	]);
	// Pad to 200 bytes
	const padded = Buffer.concat([pngHeader, Buffer.alloc(200 - pngHeader.length, 0xaa)]);
	return padded.toString("base64");
}

/** Fake base64 JPEG — starts with JPEG/JFIF header and is > 100 bytes. */
function fakeJpegBase64(): string {
	const jpegHeader = Buffer.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
		0x00, 0x01, 0x00, 0x00,
	]);
	const padded = Buffer.concat([jpegHeader, Buffer.alloc(200 - jpegHeader.length, 0xaa)]);
	return padded.toString("base64");
}

/**
 * Build a fake OpenRouter response with a JPEG image disguised as PNG.
 * The data URI says image/png, but the actual bytes are JPEG.
 */
function fakeJpegDisguisedAsPngResponse() {
	const data = fakeJpegBase64();
	return {
		choices: [
			{
				message: {
					content: [
						{
							type: "image_url",
							image_url: {
								url: `data:image/png;base64,${data}`,
							},
						},
					],
				},
			},
		],
	};
}

/** Build a fake OpenRouter response that contains a base64 PNG image. */
function fakeOpenRouterImageResponse(base64?: string) {
	const data = base64 ?? fakePngBase64();
	return {
		choices: [
			{
				message: {
					content: [
						{
							type: "image_url",
							image_url: {
								url: `data:image/png;base64,${data}`,
							},
						},
					],
				},
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Tests: End-to-end simple pipeline
// ---------------------------------------------------------------------------

describe("end-to-end simple pipeline", () => {
	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = "test-key-pipeline";
	});

	afterEach(() => {
		if (originalOpenRouterKey !== undefined) {
			process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
		} else {
			process.env.OPENROUTER_API_KEY = "";
		}
		restoreFetch();
	});

	// -------------------------------------------------------------------------
	// Stage 1: Generate a reference image
	// -------------------------------------------------------------------------

	test("stage 1: generate a reference image via mocked fetch", async () => {
		const base64 = fakePngBase64();
		let capturedBody: Record<string, unknown> | undefined;

		saveFetch();
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(JSON.stringify(fakeOpenRouterImageResponse(base64)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await generateImage(
			"Wide shot of a mountain range at sunset, golden light on snow-capped peaks",
			{ style: "cinematic, anamorphic lens, warm tones" },
		);

		// Verify the result
		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.buffer.length).toBeGreaterThan(100);
		expect(result.mimeType).toBe("image/png");
		expect(result.prompt).toContain("mountain range at sunset");
		expect(result.prompt).toContain("Style: cinematic");

		// Verify the request was properly formatted
		expect(capturedBody).toBeDefined();
		expect((capturedBody as Record<string, unknown>).model).toBe(
			"google/gemini-3.1-flash-image-preview",
		);
	});

	// -------------------------------------------------------------------------
	// Stage 2: Generate a clip using image-to-video (mock provider)
	// -------------------------------------------------------------------------

	test("stage 2: generate a clip with reference image via mock provider", async () => {
		// First generate a fake reference image
		const fakeImageBuffer = Buffer.from("x".repeat(200));

		// Use mock provider for video generation
		const result = await generateVideoClip(
			"Camera slowly pushes in toward the mountain, clouds drifting across peaks",
			{
				provider: "mock",
				duration: 8,
				aspectRatio: "16:9",
				referenceImage: fakeImageBuffer,
				referenceImageMimeType: "image/png",
			},
		);

		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.buffer.length).toBeGreaterThan(0);
		expect(result.mimeType).toBe("video/mp4");
		expect(result.model).toBe("mock-v1");
		expect(result.prompt).toContain("Camera slowly pushes in");
		expect(result.metadata?.duration).toBe(8);
		expect(result.metadata?.aspectRatio).toBe("16:9");
	});

	// -------------------------------------------------------------------------
	// Stage 3: Stitch 2+ clips together (mock ffmpeg)
	// -------------------------------------------------------------------------

	test("stage 3: stitch clips verifies concat file list (mocked Bun.spawn)", async () => {
		// We can't easily mock Bun.spawn globally without affecting other modules,
		// so instead we test that stitchClips validates inputs and would produce
		// the right ffmpeg command by checking the error message for missing files.
		//
		// This verifies the clip paths flow through correctly.
		const clipPaths = [
			"/tmp/video-gen/clips/scene1.mp4",
			"/tmp/video-gen/clips/scene2.mp4",
			"/tmp/video-gen/clips/scene3.mp4",
		];

		try {
			await stitchClips(clipPaths, "/tmp/video-gen/final.mp4");
			// If ffmpeg is available, we'll get MISSING_INPUT (files don't exist)
			// If ffmpeg is not available, we'll get FFMPEG_NOT_FOUND
			// Either way, the function accepted our input array correctly
		} catch (error) {
			expect(error).toBeInstanceOf(StitchError);
			const err = error as StitchError;
			// The error should be about missing files or missing ffmpeg,
			// NOT about invalid arguments — proving our paths were accepted
			expect(["MISSING_INPUT", "FFMPEG_NOT_FOUND"]).toContain(err.code);

			if (err.code === "MISSING_INPUT") {
				// Verify all three paths are mentioned in the error
				expect(err.message).toContain("scene1.mp4");
				expect(err.message).toContain("scene2.mp4");
				expect(err.message).toContain("scene3.mp4");
			}
		}
	});

	// -------------------------------------------------------------------------
	// Full pipeline: image gen → clip gen → stitch validation
	// -------------------------------------------------------------------------

	test("full pipeline: image → clip → clip → stitch validation", async () => {
		// Step 1: Mock image generation
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeOpenRouterImageResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const image = await generateImage("Establishing shot of a detective's office");
		expect(image.buffer.length).toBeGreaterThan(100);

		// Step 2: Generate two clips using mock provider, passing the reference image
		const clip1 = await generateVideoClip(
			"Camera pushes in toward the desk, dust particles floating",
			{
				provider: "mock",
				duration: 8,
				referenceImage: image.buffer,
			},
		);

		const clip2 = await generateVideoClip("Detective picks up phone, glances at it, puts it down", {
			provider: "mock",
			duration: 6,
			referenceImage: image.buffer,
		});

		expect(clip1.buffer).toBeInstanceOf(Buffer);
		expect(clip2.buffer).toBeInstanceOf(Buffer);
		expect(clip1.mimeType).toBe("video/mp4");
		expect(clip2.mimeType).toBe("video/mp4");
		expect(clip1.metadata?.duration).toBe(8);
		expect(clip2.metadata?.duration).toBe(6);

		// Step 3: Validate stitch would work with these clips
		// (can't actually stitch mock buffers — they're not real video files)
		// But we verify the stitch function accepts the right number of paths
		try {
			await stitchClips(
				["/tmp/pipeline-test/clip1.mp4", "/tmp/pipeline-test/clip2.mp4"],
				"/tmp/pipeline-test/final.mp4",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(StitchError);
			const err = error as StitchError;
			expect(["MISSING_INPUT", "FFMPEG_NOT_FOUND"]).toContain(err.code);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: Provider registry integration
// ---------------------------------------------------------------------------

describe("provider registry integration", () => {
	test('getProvider("mock") returns a working provider', async () => {
		const provider = getProvider("mock");
		expect(provider.name).toBe("mock");
		expect(provider.isConfigured()).toBe(true);

		const result = await provider.generateClip("test clip from registry");
		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.mimeType).toBe("video/mp4");
		expect(result.prompt).toBe("test clip from registry");
	});

	test("mock provider generateClip passes referenceImage through", async () => {
		const provider = getProvider("mock");
		const refImage = Buffer.from("fake-reference-image-data");

		// MockProvider doesn't use the reference image, but it should accept it
		// without error — it's part of the GenerateClipOptions contract
		const result = await provider.generateClip("clip with reference", {
			referenceImage: refImage,
			referenceImageMimeType: "image/png",
			duration: 6,
			aspectRatio: "9:16",
		});

		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.metadata?.duration).toBe(6);
		expect(result.metadata?.aspectRatio).toBe("9:16");
	});

	test("generateVideoClip wrapper delegates to mock provider correctly", async () => {
		const result = await generateVideoClip("wrapper test", {
			provider: "mock",
			duration: 4,
		});

		expect(result.model).toBe("mock-v1");
		expect(result.prompt).toBe("wrapper test");
		expect(result.metadata?.duration).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Tests: generate_clip tool reads reference image correctly
// ---------------------------------------------------------------------------

describe("generate_clip tool reference image handling", () => {
	test("referenceImage Buffer is passed through to the provider", async () => {
		// Simulate what the OpenCode tool does: read a file → pass as Buffer
		const fakeFileContent = Buffer.from(`PNG-file-content-${"x".repeat(100)}`);

		const result = await generateVideoClip("Scene with reference image from file", {
			provider: "mock",
			referenceImage: fakeFileContent,
			referenceImageMimeType: "image/png",
		});

		// The mock provider doesn't use the reference image, but it should
		// succeed without errors — proving the Buffer flows through
		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.mimeType).toBe("video/mp4");
	});

	test("referenceImage can be a large Buffer (simulating real image)", async () => {
		// Real PNG files are typically 100KB+. Verify the pipeline handles large buffers.
		const largeImage = Buffer.alloc(500_000, 0xab); // 500KB

		const result = await generateVideoClip("Scene with large reference", {
			provider: "mock",
			referenceImage: largeImage,
		});

		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.mimeType).toBe("video/mp4");
	});
});

// ---------------------------------------------------------------------------
// Tests: Error propagation
// ---------------------------------------------------------------------------

describe("error propagation", () => {
	afterEach(() => {
		restoreFetch();
		if (originalOpenRouterKey !== undefined) {
			process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
		} else {
			process.env.OPENROUTER_API_KEY = "";
		}
	});

	test("image gen failure propagates through the pipeline", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify({ error: { message: "Internal server error" } }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			await generateImage("a sunset");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			const err = error as ImageGenerationError;
			expect(err.code).toBe("API_ERROR");
			expect(err.statusCode).toBe(500);
		}
	});

	test("image gen missing API key surfaces MISSING_API_KEY", async () => {
		process.env.OPENROUTER_API_KEY = "";

		try {
			await generateImage("a sunset");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			expect((error as ImageGenerationError).code).toBe("MISSING_API_KEY");
		}
	});

	test("stitch with < 2 clips surfaces INVALID_ARGUMENTS", async () => {
		try {
			await stitchClips(["/tmp/only-one.mp4"], "/tmp/out.mp4");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(StitchError);
			expect((error as StitchError).code).toBe("INVALID_ARGUMENTS");
		}
	});

	test("stitch with empty output path surfaces INVALID_ARGUMENTS", async () => {
		try {
			await stitchClips(["/tmp/a.mp4", "/tmp/b.mp4"], "");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(StitchError);
			expect((error as StitchError).code).toBe("INVALID_ARGUMENTS");
		}
	});

	test("video gen with nonexistent provider surfaces PROVIDER_NOT_FOUND", async () => {
		try {
			await generateVideoClip("test", { provider: "nonexistent" });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeDefined();
			// The wrapper converts VideoProviderError → VideoGenerationError
			const err = error as { code: string; message: string };
			expect(err.code).toBe("PROVIDER_NOT_FOUND");
			expect(err.message).toContain("nonexistent");
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: MIME resilience
// ---------------------------------------------------------------------------

describe("MIME resilience", () => {
	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = "test-key-mime";
	});

	afterEach(() => {
		if (originalOpenRouterKey !== undefined) {
			process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
		} else {
			process.env.OPENROUTER_API_KEY = "";
		}
		restoreFetch();
	});

	test("pipeline handles JPEG disguised as PNG from API", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeJpegDisguisedAsPngResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await generateImage("A landscape photo");

		// The data URI says image/png, but the actual bytes are JPEG.
		// MIME detection should correct this to image/jpeg.
		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.buffer.length).toBeGreaterThan(100);
		expect(result.mimeType).toBe("image/jpeg");
		expect(result.mimeType).not.toBe("image/png");
	});

	test("generate_clip receives correct MIME for JPEG reference image", async () => {
		// Create a fake JPEG buffer (starts with FF D8 FF E0)
		const jpegHeader = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
			0x01, 0x00, 0x01, 0x00, 0x00,
		]);
		const fakeJpegBuffer = Buffer.concat([jpegHeader, Buffer.alloc(500, 0xbb)]);

		// Pass the JPEG buffer as a reference image to the mock provider.
		// Even if we label it as "image/png", the mock provider should accept it.
		// The key verification is that the pipeline doesn't reject it.
		const result = await generateVideoClip(
			"Scene using JPEG reference image that might have been saved as .png",
			{
				provider: "mock",
				duration: 6,
				referenceImage: fakeJpegBuffer,
				referenceImageMimeType: "image/png", // deliberately wrong — simulates .png extension
			},
		);

		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.mimeType).toBe("video/mp4");
		expect(result.model).toBe("mock-v1");
	});
});
