import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ImageGenerationError, generateImage } from "../image-gen";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalEnv = process.env.OPENROUTER_API_KEY;
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

/** Build a fake JPEG buffer (starts with FF D8 FF E0 JFIF header) padded to >100 bytes. */
function fakeJpegBuffer(): Buffer {
	const header = Buffer.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
		0x00, 0x01, 0x00, 0x00,
	]);
	return Buffer.concat([header, Buffer.alloc(200 - header.length, 0xaa)]);
}

/** Build a fake PNG buffer (starts with 89 50 4E 47 signature) padded to >100 bytes. */
function fakePngBuffer(): Buffer {
	const header = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00,
	]);
	return Buffer.concat([header, Buffer.alloc(200 - header.length, 0xaa)]);
}

/** Build a fake OpenRouter response with a base64 image in a data URI. */
function fakeImageResponse(base64Data?: string, mimeLabel?: string) {
	const data =
		base64Data ??
		// Generate a fake base64 payload large enough to pass the >100 byte sanity check.
		Buffer.from("x".repeat(200)).toString("base64");

	const mime = mimeLabel ?? "image/png";

	return {
		choices: [
			{
				message: {
					content: [
						{
							type: "image_url",
							image_url: {
								url: `data:${mime};base64,${data}`,
							},
						},
					],
				},
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateImage", () => {
	beforeEach(() => {
		// Default: set a fake key so most tests don't hit the MISSING_API_KEY path
		process.env.OPENROUTER_API_KEY = "test-key-12345";
	});

	afterEach(() => {
		// Restore original env
		if (originalEnv !== undefined) {
			process.env.OPENROUTER_API_KEY = originalEnv;
		} else {
			process.env.OPENROUTER_API_KEY = "";
		}
		restoreFetch();
	});

	// -------------------------------------------------------------------------
	// API key validation
	// -------------------------------------------------------------------------

	test("throws MISSING_API_KEY when env var is not set", async () => {
		process.env.OPENROUTER_API_KEY = "";

		try {
			await generateImage("a sunset over the ocean");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			const err = error as ImageGenerationError;
			expect(err.code).toBe("MISSING_API_KEY");
			expect(err.message).toContain("OPENROUTER_API_KEY");
		}
	});

	test("throws MISSING_API_KEY when env var is empty string", async () => {
		process.env.OPENROUTER_API_KEY = "";

		try {
			await generateImage("a sunset over the ocean");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			expect((error as ImageGenerationError).code).toBe("MISSING_API_KEY");
		}
	});

	test("throws MISSING_API_KEY when env var is whitespace only", async () => {
		process.env.OPENROUTER_API_KEY = "   ";

		try {
			await generateImage("a sunset over the ocean");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			expect((error as ImageGenerationError).code).toBe("MISSING_API_KEY");
		}
	});

	// -------------------------------------------------------------------------
	// Prompt validation
	// -------------------------------------------------------------------------

	test("throws with empty prompt", async () => {
		try {
			await generateImage("");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			expect((error as ImageGenerationError).code).toBe("API_ERROR");
			expect((error as ImageGenerationError).message).toContain("non-empty");
		}
	});

	test("throws with whitespace-only prompt", async () => {
		try {
			await generateImage("   ");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			expect((error as ImageGenerationError).code).toBe("API_ERROR");
		}
	});

	// -------------------------------------------------------------------------
	// Request formatting
	// -------------------------------------------------------------------------

	test("sends correct request body shape to OpenRouter", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		saveFetch();
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return new Response(JSON.stringify(fakeImageResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await generateImage("a cat sitting on a rainbow");

		// Verify URL
		expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");

		// Verify method and headers
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-key-12345");
		expect(headers["Content-Type"]).toBe("application/json");

		// Verify request body shape
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("google/gemini-3.1-flash-image-preview");
		expect(body.messages).toBeArrayOfSize(1);
		expect(body.messages[0].role).toBe("user");
		expect(body.messages[0].content).toContain("a cat sitting on a rainbow");
		expect(body.messages[0].content).toContain("Generate an image of:");
	});

	test("includes style modifier in prompt when provided", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		saveFetch();
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(JSON.stringify(fakeImageResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await generateImage("a forest", { style: "watercolor painting" });

		const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
		expect(messages[0].content).toContain("a forest");
		expect(messages[0].content).toContain("Style: watercolor painting");
	});

	test("includes dimension hints in request body when provided", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		saveFetch();
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(JSON.stringify(fakeImageResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await generateImage("a mountain", { width: 1920, height: 1080 });

		const genConfig = capturedBody?.generation_config as Record<string, number> | undefined;
		expect(genConfig).toBeDefined();
		expect(genConfig?.width).toBe(1920);
		expect(genConfig?.height).toBe(1080);
	});

	test("uses custom model when provided", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		saveFetch();
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(JSON.stringify(fakeImageResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await generateImage("test prompt", { model: "custom/model-v2" });

		expect(capturedBody?.model).toBe("custom/model-v2");
	});

	// -------------------------------------------------------------------------
	// Response parsing
	// -------------------------------------------------------------------------

	test("parses image from data URI in image_url part", async () => {
		// Use real PNG magic bytes so MIME detection confirms PNG
		const pngData = fakePngBuffer();
		const base64 = pngData.toString("base64");

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeImageResponse(base64)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await generateImage("test prompt");

		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.buffer.length).toBeGreaterThan(100);
		expect(result.mimeType).toBe("image/png");
		expect(result.model).toBe("google/gemini-3.1-flash-image-preview");
		expect(result.prompt).toContain("test prompt");
	});

	test("parses image from inline_data part", async () => {
		// Use real JPEG magic bytes so MIME detection confirms JPEG
		const jpegData = fakeJpegBuffer();
		const base64 = jpegData.toString("base64");

		const response = {
			choices: [
				{
					message: {
						content: [
							{
								type: "inline_data",
								inline_data: {
									data: base64,
									mime_type: "image/jpeg",
								},
							},
						],
					},
				},
			],
		};

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await generateImage("test prompt");

		expect(result.buffer.length).toBeGreaterThan(100);
		expect(result.mimeType).toBe("image/jpeg");
	});

	// -------------------------------------------------------------------------
	// MIME correction — detectMimeType overrides wrong API metadata
	// -------------------------------------------------------------------------

	test("corrects mimeType when API says PNG but data is JPEG", async () => {
		// API returns data:image/png;base64,... but the actual bytes are JPEG
		const jpegData = fakeJpegBuffer();
		const base64 = jpegData.toString("base64");

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeImageResponse(base64, "image/png")), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await generateImage("test prompt");

		expect(result.buffer.length).toBeGreaterThan(100);
		// The declared MIME was image/png, but actual bytes are JPEG — detection should correct it
		expect(result.mimeType).toBe("image/jpeg");
	});

	test("corrects mimeType when inline_data has wrong mime_type", async () => {
		// inline_data declares mime_type "image/png" but the actual bytes are JPEG
		const jpegData = fakeJpegBuffer();
		const base64 = jpegData.toString("base64");

		const response = {
			choices: [
				{
					message: {
						content: [
							{
								type: "inline_data",
								inline_data: {
									data: base64,
									mime_type: "image/png",
								},
							},
						],
					},
				},
			],
		};

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await generateImage("test prompt");

		expect(result.buffer.length).toBeGreaterThan(100);
		expect(result.mimeType).toBe("image/jpeg");
	});

	test("handles raw base64 JPEG without data URI", async () => {
		// Content is a string containing a long base64 block that decodes to JPEG
		const jpegData = fakeJpegBuffer();
		const base64 = jpegData.toString("base64");

		const response = {
			choices: [
				{
					message: {
						content: `Here is the generated image: ${base64}`,
					},
				},
			],
		};

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await generateImage("test prompt");

		expect(result.buffer.length).toBeGreaterThan(100);
		// Without a data URI, detection from bytes should identify it as JPEG
		expect(result.mimeType).toBe("image/jpeg");
	});

	// -------------------------------------------------------------------------
	// Error handling
	// -------------------------------------------------------------------------

	test("throws NO_IMAGE_IN_RESPONSE when response has no image data", async () => {
		const response = {
			choices: [
				{
					message: {
						content: "I'm sorry, I can only generate text responses.",
					},
				},
			],
		};

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			await generateImage("test prompt");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			expect((error as ImageGenerationError).code).toBe("NO_IMAGE_IN_RESPONSE");
		}
	});

	test("throws INVALID_RESPONSE when response has no choices", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify({ choices: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			await generateImage("test prompt");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			expect((error as ImageGenerationError).code).toBe("INVALID_RESPONSE");
		}
	});

	test("throws API_ERROR on non-429 HTTP error", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify({ error: { message: "Invalid request" } }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			await generateImage("test prompt");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			const err = error as ImageGenerationError;
			expect(err.code).toBe("API_ERROR");
			expect(err.statusCode).toBe(400);
		}
	});

	test("throws CONTENT_POLICY on 400 with safety message", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify({ error: { message: "Blocked by safety filters" } }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			await generateImage("test prompt");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageGenerationError);
			expect((error as ImageGenerationError).code).toBe("CONTENT_POLICY");
		}
	});
});
