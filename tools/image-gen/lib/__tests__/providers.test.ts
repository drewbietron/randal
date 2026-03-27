import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ImageProviderError,
	OpenRouterImageProvider,
	getImageProvider,
	listImageProviders,
} from "../providers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalEnv = process.env.OPENROUTER_API_KEY;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Image Provider Registry", () => {
	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = "test-key-12345";
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.OPENROUTER_API_KEY = originalEnv;
		} else {
			process.env.OPENROUTER_API_KEY = "";
		}
	});

	// -------------------------------------------------------------------------
	// Auto-registration
	// -------------------------------------------------------------------------

	test("OpenRouter provider is auto-registered", () => {
		const providers = listImageProviders();
		const names = providers.map((p) => p.name);
		expect(names).toContain("openrouter");
	});

	// -------------------------------------------------------------------------
	// getImageProvider by name
	// -------------------------------------------------------------------------

	test("getImageProvider('openrouter') returns the OpenRouter provider", () => {
		const provider = getImageProvider("openrouter");
		expect(provider).toBeDefined();
		expect(provider.name).toBe("openrouter");
		expect(provider).toBeInstanceOf(OpenRouterImageProvider);
	});

	test("getImageProvider() without name returns first configured provider", () => {
		const provider = getImageProvider();
		expect(provider).toBeDefined();
		expect(provider.name).toBe("openrouter");
	});

	test("getImageProvider('nonexistent') throws ImageProviderError with PROVIDER_NOT_FOUND", () => {
		try {
			getImageProvider("nonexistent");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageProviderError);
			const err = error as ImageProviderError;
			expect(err.code).toBe("PROVIDER_NOT_FOUND");
			expect(err.message).toContain("nonexistent");
			expect(err.message).toContain("not registered");
		}
	});

	// -------------------------------------------------------------------------
	// listImageProviders
	// -------------------------------------------------------------------------

	test("listImageProviders() returns at least one provider", () => {
		const providers = listImageProviders();
		expect(providers.length).toBeGreaterThanOrEqual(1);
	});

	test("listed providers have required properties", () => {
		const providers = listImageProviders();
		for (const provider of providers) {
			expect(provider.name).toBeDefined();
			expect(typeof provider.name).toBe("string");
			expect(provider.description).toBeDefined();
			expect(typeof provider.description).toBe("string");
			expect(Array.isArray(provider.models)).toBe(true);
			expect(typeof provider.isConfigured).toBe("function");
			expect(typeof provider.generateImage).toBe("function");
		}
	});

	// -------------------------------------------------------------------------
	// isConfigured
	// -------------------------------------------------------------------------

	test("provider isConfigured() returns true when API key is set", () => {
		process.env.OPENROUTER_API_KEY = "test-key-12345";
		const provider = getImageProvider("openrouter");
		expect(provider.isConfigured()).toBe(true);
	});

	test("provider isConfigured() returns false when API key is missing", () => {
		process.env.OPENROUTER_API_KEY = "";
		const provider = new OpenRouterImageProvider();
		expect(provider.isConfigured()).toBe(false);
	});

	test("provider isConfigured() returns false when API key is whitespace", () => {
		process.env.OPENROUTER_API_KEY = "   ";
		const provider = new OpenRouterImageProvider();
		expect(provider.isConfigured()).toBe(false);
	});

	// -------------------------------------------------------------------------
	// No configured provider
	// -------------------------------------------------------------------------

	test("getImageProvider() throws NO_CONFIGURED_PROVIDER when no API key", () => {
		process.env.OPENROUTER_API_KEY = "";

		try {
			getImageProvider();
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ImageProviderError);
			const err = error as ImageProviderError;
			expect(err.code).toBe("NO_CONFIGURED_PROVIDER");
		}
	});

	// -------------------------------------------------------------------------
	// Provider metadata
	// -------------------------------------------------------------------------

	test("OpenRouter provider has correct metadata", () => {
		const provider = getImageProvider("openrouter");
		expect(provider.name).toBe("openrouter");
		expect(provider.description).toContain("OpenRouter");
		expect(provider.models.length).toBeGreaterThan(0);
		expect(provider.models).toContain("google/gemini-3.1-flash-image-preview");
	});
});
