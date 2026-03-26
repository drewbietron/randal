import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	AudioGenError,
	generateSpeech,
	generateMusic,
	mixAudioTracks,
	attachAudioToVideo,
} from "../audio-gen";
import {
	getAudioProvider,
	listAudioProviders,
	registerAudioProvider,
} from "../providers/audio-registry";
import { ElevenLabsProvider } from "../providers/elevenlabs";
import { OpenRouterTTSProvider } from "../providers/openrouter-tts";
import { VideoProviderError } from "../providers/types";
import type { AudioProvider, GenerateSpeechResult } from "../providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let savedFetch: typeof globalThis.fetch | undefined;
let savedElevenLabsKey: string | undefined;
let savedOpenRouterKey: string | undefined;

function saveFetch() {
	savedFetch = globalThis.fetch;
}

function restoreFetch() {
	if (savedFetch) {
		globalThis.fetch = savedFetch;
		savedFetch = undefined;
	}
}

function saveEnv() {
	savedElevenLabsKey = process.env.ELEVENLABS_API_KEY;
	savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
}

function restoreEnv() {
	if (savedElevenLabsKey !== undefined) {
		process.env.ELEVENLABS_API_KEY = savedElevenLabsKey;
	} else {
		delete process.env.ELEVENLABS_API_KEY;
	}
	if (savedOpenRouterKey !== undefined) {
		process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
	} else {
		delete process.env.OPENROUTER_API_KEY;
	}
}

/** Build a fake audio buffer (at least 200 bytes so providers don't reject it). */
function fakeAudioBuffer(): Buffer {
	// Start with an MP3 frame sync header (FF FB)
	const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
	return Buffer.concat([header, Buffer.alloc(200 - header.length, 0xaa)]);
}

// ---------------------------------------------------------------------------
// ElevenLabs provider tests (mocked HTTP)
// ---------------------------------------------------------------------------

describe("ElevenLabsProvider", () => {
	beforeEach(() => {
		saveFetch();
		saveEnv();
	});

	afterEach(() => {
		restoreFetch();
		restoreEnv();
	});

	test("throws MISSING_API_KEY when ELEVENLABS_API_KEY not set", async () => {
		delete process.env.ELEVENLABS_API_KEY;
		const provider = new ElevenLabsProvider();

		try {
			await provider.generateSpeech("Hello world");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(VideoProviderError);
			const err = error as VideoProviderError;
			expect(err.code).toBe("MISSING_API_KEY");
			expect(err.provider).toBe("elevenlabs");
		}
	});

	test("sends correct request to ElevenLabs API", async () => {
		process.env.ELEVENLABS_API_KEY = "test-key-11labs";
		const provider = new ElevenLabsProvider();
		const audioData = fakeAudioBuffer();

		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		let capturedBody = "";

		globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedHeaders = Object.fromEntries(
				Object.entries(init?.headers as Record<string, string>),
			);
			capturedBody = init?.body as string;
			return new Response(audioData, {
				status: 200,
				headers: { "Content-Type": "audio/mpeg" },
			});
		};

		await provider.generateSpeech("Hello world", { voice: "custom-voice" });

		expect(capturedUrl).toContain("/text-to-speech/custom-voice");
		expect(capturedUrl).toContain("output_format=mp3_44100_128");
		expect(capturedHeaders["xi-api-key"]).toBe("test-key-11labs");
		expect(capturedHeaders["Content-Type"]).toBe("application/json");

		const body = JSON.parse(capturedBody);
		expect(body.text).toBe("Hello world");
		expect(body.model_id).toBe("eleven_multilingual_v2");
	});

	test("returns audio buffer from ElevenLabs response", async () => {
		process.env.ELEVENLABS_API_KEY = "test-key-11labs";
		const provider = new ElevenLabsProvider();
		const audioData = fakeAudioBuffer();

		globalThis.fetch = async () =>
			new Response(audioData, {
				status: 200,
				headers: { "Content-Type": "audio/mpeg" },
			});

		const result = await provider.generateSpeech("Hello world");
		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.buffer.length).toBe(audioData.length);
		expect(result.mimeType).toBe("audio/mpeg");
		expect(result.model).toBe("eleven_multilingual_v2");
		expect(result.metadata?.provider).toBe("elevenlabs");
	});

	test("retries on 429 rate limit", async () => {
		process.env.ELEVENLABS_API_KEY = "test-key-11labs";
		// Use a custom base URL to avoid delay differences
		const provider = new ElevenLabsProvider({ apiBaseUrl: "https://test-api.local/v1" });
		const audioData = fakeAudioBuffer();

		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(JSON.stringify({ detail: "rate limited" }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(audioData, {
				status: 200,
				headers: { "Content-Type": "audio/mpeg" },
			});
		};

		const result = await provider.generateSpeech("Hello world");
		expect(callCount).toBeGreaterThanOrEqual(2);
		expect(result.buffer.length).toBe(audioData.length);
	});
});

// ---------------------------------------------------------------------------
// OpenRouter TTS provider tests (mocked HTTP)
// ---------------------------------------------------------------------------

describe("OpenRouterTTSProvider", () => {
	beforeEach(() => {
		saveFetch();
		saveEnv();
	});

	afterEach(() => {
		restoreFetch();
		restoreEnv();
	});

	test("throws MISSING_API_KEY when OPENROUTER_API_KEY not set", async () => {
		delete process.env.OPENROUTER_API_KEY;
		const provider = new OpenRouterTTSProvider();

		try {
			await provider.generateSpeech("Hello world");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(VideoProviderError);
			const err = error as VideoProviderError;
			expect(err.code).toBe("MISSING_API_KEY");
			expect(err.provider).toBe("openrouter-tts");
		}
	});

	test("sends correct request to OpenRouter audio/speech endpoint", async () => {
		process.env.OPENROUTER_API_KEY = "test-key-or";
		const provider = new OpenRouterTTSProvider();
		const audioData = fakeAudioBuffer();

		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		let capturedBody = "";

		globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedHeaders = Object.fromEntries(
				Object.entries(init?.headers as Record<string, string>),
			);
			capturedBody = init?.body as string;
			return new Response(audioData, {
				status: 200,
				headers: { "Content-Type": "audio/mpeg" },
			});
		};

		await provider.generateSpeech("Hello world", {
			voice: "nova",
			model: "openai/tts-1-hd",
		});

		expect(capturedUrl).toContain("/audio/speech");
		expect(capturedHeaders.Authorization).toBe("Bearer test-key-or");

		const body = JSON.parse(capturedBody);
		expect(body.model).toBe("openai/tts-1-hd");
		expect(body.input).toBe("Hello world");
		expect(body.voice).toBe("nova");
	});

	test("returns audio buffer from response", async () => {
		process.env.OPENROUTER_API_KEY = "test-key-or";
		const provider = new OpenRouterTTSProvider();
		const audioData = fakeAudioBuffer();

		globalThis.fetch = async () =>
			new Response(audioData, {
				status: 200,
				headers: { "Content-Type": "audio/mpeg" },
			});

		const result = await provider.generateSpeech("Hello world");
		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.buffer.length).toBe(audioData.length);
		expect(result.mimeType).toBe("audio/mpeg");
		expect(result.model).toBe("openai/tts-1");
		expect(result.metadata?.provider).toBe("openrouter-tts");
	});
});

// ---------------------------------------------------------------------------
// Audio registry tests
// ---------------------------------------------------------------------------

describe("Audio registry", () => {
	beforeEach(() => {
		saveEnv();
	});

	afterEach(() => {
		restoreEnv();
	});

	test("has elevenlabs provider registered", () => {
		const provider = getAudioProvider("elevenlabs");
		expect(provider.name).toBe("elevenlabs");
	});

	test("has openrouter-tts provider registered", () => {
		const provider = getAudioProvider("openrouter-tts");
		expect(provider.name).toBe("openrouter-tts");
	});

	test("listAudioProviders returns both providers", () => {
		const providers = listAudioProviders();
		const names = providers.map((p) => p.name);
		expect(names).toContain("elevenlabs");
		expect(names).toContain("openrouter-tts");
	});

	test("getAudioProvider throws for nonexistent provider", () => {
		try {
			getAudioProvider("does-not-exist");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(VideoProviderError);
			const err = error as VideoProviderError;
			expect(err.code).toBe("PROVIDER_NOT_FOUND");
			expect(err.message).toContain("does-not-exist");
		}
	});
});

// ---------------------------------------------------------------------------
// generateSpeech wrapper tests
// ---------------------------------------------------------------------------

describe("generateSpeech", () => {
	beforeEach(() => {
		saveFetch();
		saveEnv();
	});

	afterEach(() => {
		restoreFetch();
		restoreEnv();
	});

	test("delegates to correct provider", async () => {
		process.env.ELEVENLABS_API_KEY = "test-key";
		const audioData = fakeAudioBuffer();

		globalThis.fetch = async () =>
			new Response(audioData, {
				status: 200,
				headers: { "Content-Type": "audio/mpeg" },
			});

		const result = await generateSpeech("Hello world", {
			provider: "elevenlabs",
		});

		expect(result.buffer).toBeInstanceOf(Buffer);
		expect(result.mimeType).toBe("audio/mpeg");
		expect(result.metadata?.provider).toBe("elevenlabs");
	});

	test("throws MISSING_API_KEY propagated from provider", async () => {
		delete process.env.ELEVENLABS_API_KEY;

		try {
			await generateSpeech("Hello", { provider: "elevenlabs" });
			expect.unreachable("should have thrown");
		} catch (error) {
			// The error should propagate through — it's a VideoProviderError
			// wrapped as AudioGenError's PROVIDER_ERROR or the raw VideoProviderError
			expect(error).toBeTruthy();
			const msg = error instanceof Error ? error.message : String(error);
			expect(msg).toContain("ELEVENLABS_API_KEY");
		}
	});
});

// ---------------------------------------------------------------------------
// generateMusic wrapper tests
// ---------------------------------------------------------------------------

describe("generateMusic", () => {
	beforeEach(() => {
		saveEnv();
	});

	afterEach(() => {
		restoreEnv();
	});

	test("throws MUSIC_NOT_SUPPORTED when provider has no generateMusic", async () => {
		// ElevenLabs and OpenRouter TTS don't support music
		process.env.ELEVENLABS_API_KEY = "test-key";

		try {
			await generateMusic("epic cinematic music", { provider: "elevenlabs" });
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(AudioGenError);
			const err = error as AudioGenError;
			expect(err.code).toBe("MUSIC_NOT_SUPPORTED");
			expect(err.message).toContain("elevenlabs");
		}
	});
});

// ---------------------------------------------------------------------------
// mixAudioTracks validation tests
// ---------------------------------------------------------------------------

describe("mixAudioTracks", () => {
	test("throws INVALID_ARGUMENTS with empty tracks array", async () => {
		try {
			await mixAudioTracks([], "/tmp/test-mix.mp3");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(AudioGenError);
			const err = error as AudioGenError;
			expect(err.code).toBe("INVALID_ARGUMENTS");
			expect(err.message).toContain("at least 1");
		}
	});

	test("throws INVALID_ARGUMENTS with empty output path", async () => {
		try {
			await mixAudioTracks([{ path: "/tmp/a.mp3" }], "");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(AudioGenError);
			const err = error as AudioGenError;
			expect(err.code).toBe("INVALID_ARGUMENTS");
			expect(err.message).toContain("non-empty");
		}
	});

	test("throws MISSING_INPUT when track file doesn't exist", async () => {
		try {
			await mixAudioTracks(
				[{ path: "/tmp/nonexistent-audio-track-12345.mp3" }],
				"/tmp/test-mix-output.mp3",
			);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(AudioGenError);
			const err = error as AudioGenError;
			expect(err.code).toBe("MISSING_INPUT");
			expect(err.message).toContain("nonexistent-audio-track-12345");
		}
	});
});

// ---------------------------------------------------------------------------
// attachAudioToVideo validation tests
// ---------------------------------------------------------------------------

describe("attachAudioToVideo", () => {
	test("throws MISSING_INPUT when video file doesn't exist", async () => {
		try {
			await attachAudioToVideo(
				"/tmp/nonexistent-video-12345.mp4",
				"/tmp/some-audio.mp3",
				"/tmp/output.mp4",
			);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(AudioGenError);
			const err = error as AudioGenError;
			expect(err.code).toBe("MISSING_INPUT");
			expect(err.message).toContain("Video");
			expect(err.message).toContain("nonexistent-video-12345");
		}
	});

	test("throws MISSING_INPUT when audio file doesn't exist", async () => {
		// Create a temporary video file so the first check passes
		const tmpVideo = `/tmp/test-video-${crypto.randomUUID()}.mp4`;
		await Bun.write(tmpVideo, Buffer.alloc(100, 0x00));

		try {
			await attachAudioToVideo(
				tmpVideo,
				"/tmp/nonexistent-audio-12345.mp3",
				"/tmp/output.mp4",
			);
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(AudioGenError);
			const err = error as AudioGenError;
			expect(err.code).toBe("MISSING_INPUT");
			expect(err.message).toContain("Audio");
			expect(err.message).toContain("nonexistent-audio-12345");
		} finally {
			// Cleanup
			try {
				const { unlink } = await import("node:fs/promises");
				await unlink(tmpVideo);
			} catch {
				// best effort
			}
		}
	});
});
