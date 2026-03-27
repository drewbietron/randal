/**
 * Image provider registry — register, select, and list image generation providers.
 *
 * Mirrors the video provider registry pattern. Built-in providers are
 * auto-registered on import.
 */

import { OpenRouterImageProvider } from "./openrouter-image";
import type { ImageProvider } from "./types";
import { ImageProviderError } from "./types";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const imageProviders = new Map<string, ImageProvider>();

/**
 * Register an image provider. Overwrites any existing provider with the same name.
 */
export function registerImageProvider(provider: ImageProvider): void {
	imageProviders.set(provider.name, provider);
}

/**
 * Get an image provider by name.
 *
 * - If `name` is provided, returns that specific provider (throws if not found).
 * - If `name` is omitted, returns the first configured provider (throws if none).
 */
export function getImageProvider(name?: string): ImageProvider {
	if (name) {
		const provider = imageProviders.get(name);
		if (!provider) {
			const available = Array.from(imageProviders.keys()).join(", ");
			throw new ImageProviderError(
				`Image provider "${name}" is not registered. Available: ${available || "(none)"}`,
				"PROVIDER_NOT_FOUND",
				name,
			);
		}
		return provider;
	}

	// No name given — return the first configured provider
	for (const provider of imageProviders.values()) {
		if (provider.isConfigured()) {
			return provider;
		}
	}

	// Nothing configured — throw a helpful error
	const available = Array.from(imageProviders.values())
		.map((p) => `  - ${p.name}: ${p.isConfigured() ? "configured" : "NOT configured"}`)
		.join("\n");

	throw new ImageProviderError(
		`No image provider is configured.\nRegistered providers:\n${available || "  (none)"}`,
		"NO_CONFIGURED_PROVIDER",
		"image-registry",
	);
}

/**
 * List all registered image providers (with configuration status).
 */
export function listImageProviders(): ImageProvider[] {
	return Array.from(imageProviders.values());
}

// ---------------------------------------------------------------------------
// Auto-register built-in providers
// ---------------------------------------------------------------------------

registerImageProvider(new OpenRouterImageProvider());
