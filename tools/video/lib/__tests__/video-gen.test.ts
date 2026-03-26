import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getProvider, listProviders } from "../providers/registry";
import { VideoProviderError } from "../providers/types";
import { generateVideoClip } from "../video-gen";

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
