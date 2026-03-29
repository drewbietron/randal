import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getProvider, listProviders } from "../providers/registry";
import { VideoProviderError } from "../providers/types";
import { generateVideoClip } from "../video-gen";
// VeoProvider is imported dynamically in fallback tests (constructor reads env vars)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalGoogleKey = process.env.GOOGLE_AI_STUDIO_KEY;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provider registry", () => {
	test('has "veo" provider registered', () => {
		const provider = getProvider("veo");
		expect(provider).toBeDefined();
		expect(provider.name).toBe("veo");
	});

	test('has "mock" provider registered', () => {
		const provider = getProvider("mock");
		expect(provider).toBeDefined();
		expect(provider.name).toBe("mock");
	});

	test("listProviders returns at least veo and mock", () => {
		const providers = listProviders();
		const names = providers.map((p) => p.name);
		expect(names).toContain("veo");
		expect(names).toContain("mock");
	});

	test("getProvider throws for nonexistent provider", () => {
		try {
			getProvider("nonexistent");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(VideoProviderError);
			const err = error as VideoProviderError;
			expect(err.code).toBe("PROVIDER_NOT_FOUND");
			expect(err.message).toContain("nonexistent");
			expect(err.message).toContain("not registered");
		}
	});

	test("mock provider reports as always configured", () => {
		const provider = getProvider("mock");
		expect(provider.isConfigured()).toBe(true);
	});

	test("veo provider reports unconfigured when API key is missing", () => {
		const saved = process.env.GOOGLE_AI_STUDIO_KEY;
		process.env.GOOGLE_AI_STUDIO_KEY = "";
		try {
			const provider = getProvider("veo");
			expect(provider.isConfigured()).toBe(false);
		} finally {
			if (saved !== undefined) {
				process.env.GOOGLE_AI_STUDIO_KEY = saved;
			} else {
				process.env.GOOGLE_AI_STUDIO_KEY = "";
			}
		}
	});
});

describe("generateVideoClip", () => {
	beforeEach(() => {
		// Clear the key so veo tests fail predictably
		process.env.GOOGLE_AI_STUDIO_KEY = "";
	});

	afterEach(() => {
		if (originalGoogleKey !== undefined) {
			process.env.GOOGLE_AI_STUDIO_KEY = originalGoogleKey;
		} else {
			process.env.GOOGLE_AI_STUDIO_KEY = "";
		}
	});

	test('with provider "mock" returns a buffer', async () => {
		const result = await generateVideoClip("a flying car over the city", {
			provider: "mock",
		});

		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.buffer.length).toBeGreaterThan(0);
		expect(result.mimeType).toBe("video/mp4");
		expect(result.model).toBe("mock-v1");
		expect(result.prompt).toContain("a flying car over the city");
	});

	test('with provider "mock" respects duration and aspect ratio options', async () => {
		const result = await generateVideoClip("a sunset", {
			provider: "mock",
			duration: 4,
			aspectRatio: "9:16",
		});

		expect(result.buffer.length).toBeGreaterThan(0);
		expect(result.metadata?.duration).toBe(4);
		expect(result.metadata?.aspectRatio).toBe("9:16");
	});

	test("mock provider trims the prompt", async () => {
		const result = await generateVideoClip("  spaced prompt  ", {
			provider: "mock",
		});

		expect(result.prompt).toBe("spaced prompt");
	});

	test('throws MISSING_API_KEY when using "veo" without key', async () => {
		process.env.GOOGLE_AI_STUDIO_KEY = "";

		try {
			await generateVideoClip("a sunset", { provider: "veo" });
			expect.unreachable("should have thrown");
		} catch (error) {
			// The outer wrapper converts VideoProviderError to VideoGenerationError
			expect(error).toBeDefined();
			const err = error as { code: string; message: string };
			expect(err.code).toBe("MISSING_API_KEY");
			expect(err.message).toContain("GOOGLE_AI_STUDIO_KEY");
		}
	});

	test("mock provider buffer starts with valid ftyp box", async () => {
		const result = await generateVideoClip("test", { provider: "mock" });

		// ftyp box: bytes 4-7 should be "ftyp" (0x66, 0x74, 0x79, 0x70)
		expect(result.buffer[4]).toBe(0x66); // 'f'
		expect(result.buffer[5]).toBe(0x74); // 't'
		expect(result.buffer[6]).toBe(0x79); // 'y'
		expect(result.buffer[7]).toBe(0x70); // 'p'
	});
});

// ---------------------------------------------------------------------------
// VeoProvider fallback tests
// ---------------------------------------------------------------------------

describe("VeoProvider fallback", () => {
	let savedVertexKey: string | undefined;
	let savedProjectId: string | undefined;
	let savedAiStudioKey: string | undefined;
	let savedFetch: typeof globalThis.fetch;

	beforeEach(() => {
		savedFetch = globalThis.fetch;
		savedVertexKey = process.env.VERTEX_AI_API_KEY;
		savedProjectId = process.env.GOOGLE_CLOUD_PROJECT;
		savedAiStudioKey = process.env.GOOGLE_AI_STUDIO_KEY;
	});

	afterEach(() => {
		globalThis.fetch = savedFetch;
		process.env.VERTEX_AI_API_KEY = savedVertexKey;
		process.env.GOOGLE_CLOUD_PROJECT = savedProjectId;
		process.env.GOOGLE_AI_STUDIO_KEY = savedAiStudioKey;
	});

	test("falls back to AI Studio when Vertex returns 401", async () => {
		process.env.VERTEX_AI_API_KEY = "expired-vertex-key";
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_AI_STUDIO_KEY = "valid-studio-key";

		// Need to create a fresh provider after env change
		const { VeoProvider } = await import("../providers/veo");
		const provider = new VeoProvider();

		let callCount = 0;
		const urls: string[] = [];

		// Build fake video data (ftyp box header)
		const videoData = Buffer.alloc(2000, 0x00);
		videoData.write("ftyp", 4);
		const videoBase64 = videoData.toString("base64");

		globalThis.fetch = async (input: string | URL | Request, _init?: RequestInit) => {
			callCount++;
			const url = typeof input === "string" ? input : input.toString();
			urls.push(url);

			// First call: Vertex AI submit → 401
			if (callCount === 1) {
				expect(url).toContain("aiplatform.googleapis.com");
				return new Response(JSON.stringify({ error: { message: "Unauthorized", code: 401 } }), {
					status: 401,
				});
			}

			// Second call: AI Studio submit → success
			if (callCount === 2) {
				expect(url).toContain("generativelanguage.googleapis.com");
				return new Response(JSON.stringify({ name: "operations/test-op-123" }), { status: 200 });
			}

			// Third call: AI Studio poll → done
			if (callCount === 3) {
				return new Response(
					JSON.stringify({
						name: "operations/test-op-123",
						done: true,
						response: {
							generatedSamples: [
								{
									video: {
										bytesBase64Encoded: videoBase64,
										mimeType: "video/mp4",
									},
								},
							],
						},
					}),
					{ status: 200 },
				);
			}

			throw new Error(`Unexpected call #${callCount}`);
		};

		const result = await provider.generateClip("a sunset over the ocean");

		expect(result.buffer.length).toBeGreaterThan(1000);
		expect(result.metadata?.backend).toBe("ai-studio");
		expect(result.metadata?.usedFallback).toBe(true);
		expect(callCount).toBe(3);
	});

	test("does NOT fall back on 400 content policy error", async () => {
		process.env.VERTEX_AI_API_KEY = "valid-vertex-key";
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_AI_STUDIO_KEY = "valid-studio-key";

		const { VeoProvider } = await import("../providers/veo");
		const provider = new VeoProvider();

		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({ error: { message: "Content blocked by safety filter", code: 400 } }),
				{ status: 400 },
			);

		try {
			await provider.generateClip("blocked content");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(VideoProviderError);
			const err = error as VideoProviderError;
			expect(err.code).toBe("CONTENT_POLICY");
			// Should NOT have tried AI Studio
		}
	});

	test("does NOT fall back when no alternate backend configured", async () => {
		process.env.VERTEX_AI_API_KEY = "expired-vertex-key";
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_AI_STUDIO_KEY = undefined;

		const { VeoProvider } = await import("../providers/veo");
		const provider = new VeoProvider();

		globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: { message: "Unauthorized", code: 401 } }), {
				status: 401,
			});

		try {
			await provider.generateClip("a sunset");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(VideoProviderError);
			const err = error as VideoProviderError;
			expect(err.statusCode).toBe(401);
		}
	});
});
