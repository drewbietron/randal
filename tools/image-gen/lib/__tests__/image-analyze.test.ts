import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ImageAnalysisError, analyzeImage } from "../image-analyze";

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

/** Build a fake PNG buffer (starts with 89 50 4E 47 signature) padded to >100 bytes. */
function fakePngBuffer(): Buffer {
	const header = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00,
	]);
	return Buffer.concat([header, Buffer.alloc(200 - header.length, 0xaa)]);
}

/** Build a fake JPEG buffer. */
function fakeJpegBuffer(): Buffer {
	const header = Buffer.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
		0x00, 0x01, 0x00, 0x00,
	]);
	return Buffer.concat([header, Buffer.alloc(200 - header.length, 0xaa)]);
}

/** Build a fake successful OpenRouter vision API response. */
function fakeAnalysisResponse(content?: string) {
	return {
		choices: [
			{
				message: {
					content:
						content ??
						JSON.stringify({
							description: "A beautiful sunset over the ocean",
							objects: ["sun", "ocean", "clouds"],
							text: [],
							colors: ["orange", "blue", "purple"],
							style: "photography",
							mood: "serene",
						}),
				},
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeImage", () => {
	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = "test-key-12345";
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.OPENROUTER_API_KEY = originalEnv;
		} else {
			process.env.OPENROUTER_API_KEY = "";
		}
		restoreFetch();
	});

	// -------------------------------------------------------------------------
	// Input validation
	// -------------------------------------------------------------------------

	test("throws MISSING_API_KEY when env var is not set", async () => {
		process.env.OPENROUTER_API_KEY = "";

		try {
			await analyzeImage(fakePngBuffer(), "describe this");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			expect((error as ImageAnalysisError).code).toBe("MISSING_API_KEY");
		}
	});

	test("throws MISSING_INPUT when input is empty string", async () => {
		try {
			await analyzeImage("", "describe this");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			expect((error as ImageAnalysisError).code).toBe("MISSING_INPUT");
		}
	});

	test("throws MISSING_INPUT when input is whitespace-only string", async () => {
		try {
			await analyzeImage("   ", "describe this");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			expect((error as ImageAnalysisError).code).toBe("MISSING_INPUT");
		}
	});

	test("throws MISSING_INPUT when input buffer is empty", async () => {
		try {
			await analyzeImage(Buffer.alloc(0), "describe this");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			expect((error as ImageAnalysisError).code).toBe("MISSING_INPUT");
		}
	});

	test("throws MISSING_INPUT when file does not exist", async () => {
		try {
			await analyzeImage("/tmp/nonexistent-image-12345.png", "describe this");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			expect((error as ImageAnalysisError).code).toBe("MISSING_INPUT");
		}
	});

	// -------------------------------------------------------------------------
	// Request formatting — verify multimodal message structure
	// -------------------------------------------------------------------------

	test("sends correct multimodal request structure", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		saveFetch();
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return new Response(JSON.stringify(fakeAnalysisResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const imageBuffer = fakePngBuffer();
		await analyzeImage(imageBuffer, "What is in this image?");

		// Verify URL
		expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");

		// Verify method and headers
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-key-12345");
		expect(headers["Content-Type"]).toBe("application/json");

		// Verify request body structure
		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("google/gemini-2.5-flash");

		// System message + user message
		expect(body.messages).toBeArrayOfSize(2);
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[0].content).toContain("image analysis expert");

		// User message is multimodal: image_url + text parts
		expect(body.messages[1].role).toBe("user");
		expect(body.messages[1].content).toBeArrayOfSize(2);
		expect(body.messages[1].content[0].type).toBe("image_url");
		expect(body.messages[1].content[0].image_url.url).toContain("data:image/png;base64,");
		expect(body.messages[1].content[1].type).toBe("text");
		expect(body.messages[1].content[1].text).toBe("What is in this image?");
	});

	test("sends correct headers and default model to OpenRouter", async () => {
		let capturedInit: RequestInit | undefined;

		saveFetch();
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(JSON.stringify(fakeAnalysisResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await analyzeImage(fakePngBuffer(), "describe");

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-key-12345");

		const body = JSON.parse(capturedInit?.body as string);
		expect(body.model).toBe("google/gemini-2.5-flash");
		expect(body.temperature).toBe(0.3);
		expect(body.max_tokens).toBe(2000);
	});

	test("detects JPEG MIME type from buffer and includes in data URI", async () => {
		let capturedInit: RequestInit | undefined;

		saveFetch();
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedInit = init;
			return new Response(JSON.stringify(fakeAnalysisResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await analyzeImage(fakeJpegBuffer(), "describe");

		const body = JSON.parse(capturedInit?.body as string);
		const imageUrl = body.messages[1].content[0].image_url.url as string;
		expect(imageUrl).toContain("data:image/jpeg;base64,");
	});

	// -------------------------------------------------------------------------
	// Response parsing
	// -------------------------------------------------------------------------

	test("parses structured JSON response correctly", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeAnalysisResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await analyzeImage(fakePngBuffer(), "describe this");

		expect(result.description).toBe("A beautiful sunset over the ocean");
		expect(result.objects).toEqual(["sun", "ocean", "clouds"]);
		expect(result.text).toEqual([]);
		expect(result.colors).toEqual(["orange", "blue", "purple"]);
		expect(result.style).toBe("photography");
		expect(result.mood).toBe("serene");
		expect(result.model).toBe("google/gemini-2.5-flash");
		expect(result.rawResponse).toBeDefined();
	});

	test("parses JSON wrapped in markdown code blocks", async () => {
		const wrappedResponse =
			'```json\n{"description":"A cat","objects":["cat"],"text":[],"colors":["gray"],"style":"photo","mood":"playful"}\n```';

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeAnalysisResponse(wrappedResponse)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await analyzeImage(fakePngBuffer(), "describe");

		expect(result.description).toBe("A cat");
		expect(result.objects).toEqual(["cat"]);
	});

	test("handles malformed JSON gracefully — falls back to raw text", async () => {
		const malformedContent = "This is not JSON at all, just a plain text description of the image.";

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeAnalysisResponse(malformedContent)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await analyzeImage(fakePngBuffer(), "describe");

		// Should fall back: description is first 500 chars of raw text
		expect(result.description).toBe(malformedContent);
		expect(result.objects).toEqual([]);
		expect(result.text).toEqual([]);
		expect(result.colors).toEqual([]);
		expect(result.style).toBe("");
		expect(result.mood).toBe("");
		expect(result.rawResponse).toBe(malformedContent);
	});

	test("handles empty response from API", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "" } }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as typeof fetch;

		try {
			await analyzeImage(fakePngBuffer(), "describe");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			expect((error as ImageAnalysisError).code).toBe("INVALID_RESPONSE");
		}
	});

	// -------------------------------------------------------------------------
	// Error handling
	// -------------------------------------------------------------------------

	test("throws API_ERROR on HTTP 500", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response("Internal Server Error", {
				status: 500,
				headers: { "Content-Type": "text/plain" },
			});
		}) as typeof fetch;

		try {
			await analyzeImage(fakePngBuffer(), "describe");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			const err = error as ImageAnalysisError;
			expect(err.code).toBe("API_ERROR");
			expect(err.statusCode).toBe(500);
		}
	});

	test("throws API_ERROR on HTTP 429 rate limit", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response("Rate limited", {
				status: 429,
				headers: { "Content-Type": "text/plain" },
			});
		}) as typeof fetch;

		try {
			await analyzeImage(fakePngBuffer(), "describe");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			const err = error as ImageAnalysisError;
			expect(err.code).toBe("API_ERROR");
			expect(err.statusCode).toBe(429);
		}
	});

	test("throws API_ERROR on HTTP 401 unauthorized", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response("Unauthorized", {
				status: 401,
				headers: { "Content-Type": "text/plain" },
			});
		}) as typeof fetch;

		try {
			await analyzeImage(fakePngBuffer(), "describe");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageAnalysisError);
			const err = error as ImageAnalysisError;
			expect(err.code).toBe("API_ERROR");
			expect(err.statusCode).toBe(401);
		}
	});

	// -------------------------------------------------------------------------
	// Buffer input
	// -------------------------------------------------------------------------

	test("accepts Buffer input directly (not just file path)", async () => {
		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeAnalysisResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await analyzeImage(fakePngBuffer(), "what is this?");

		expect(result.description).toBe("A beautiful sunset over the ocean");
		expect(result.model).toBe("google/gemini-2.5-flash");
	});

	// -------------------------------------------------------------------------
	// Options overrides
	// -------------------------------------------------------------------------

	test("uses custom model when provided", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		saveFetch();
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(JSON.stringify(fakeAnalysisResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await analyzeImage(fakePngBuffer(), "describe", {
			model: "anthropic/claude-3.5-sonnet",
		});

		expect(capturedBody?.model).toBe("anthropic/claude-3.5-sonnet");
		expect(result.model).toBe("anthropic/claude-3.5-sonnet");
	});

	test("uses custom system prompt when provided", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		saveFetch();
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(JSON.stringify(fakeAnalysisResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const customPrompt = "You are an OCR expert. Extract all text from the image.";
		await analyzeImage(fakePngBuffer(), "extract text", {
			systemPrompt: customPrompt,
		});

		const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toBe(customPrompt);
	});

	// -------------------------------------------------------------------------
	// Partial/weird JSON responses
	// -------------------------------------------------------------------------

	test("handles response with missing optional fields", async () => {
		const partialJson = JSON.stringify({
			description: "A test image",
			// objects, text, colors, style, mood are missing
		});

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeAnalysisResponse(partialJson)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await analyzeImage(fakePngBuffer(), "describe");

		expect(result.description).toBe("A test image");
		expect(result.objects).toEqual([]);
		expect(result.text).toEqual([]);
		expect(result.colors).toEqual([]);
		expect(result.style).toBe("");
		expect(result.mood).toBe("");
	});

	test("filters non-string values from arrays", async () => {
		const weirdJson = JSON.stringify({
			description: "A test",
			objects: ["cat", 42, null, "dog", true],
			text: [],
			colors: ["red"],
			style: "photo",
			mood: "happy",
		});

		saveFetch();
		globalThis.fetch = (async () => {
			return new Response(JSON.stringify(fakeAnalysisResponse(weirdJson)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await analyzeImage(fakePngBuffer(), "describe");

		// Non-string values should be filtered out
		expect(result.objects).toEqual(["cat", "dog"]);
	});
});
