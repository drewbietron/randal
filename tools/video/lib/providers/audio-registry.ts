/**
 * Audio provider registry — register, select, and list audio generation providers.
 *
 * Mirrors the video and image provider registry patterns. Built-in providers
 * are auto-registered on import.
 */

import type { AudioProvider } from "./types";
import { VideoProviderError } from "./types";
import { ElevenLabsProvider } from "./elevenlabs";
import { OpenRouterTTSProvider } from "./openrouter-tts";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const audioProviders = new Map<string, AudioProvider>();

/**
 * Register an audio provider. Overwrites any existing provider with the same name.
 */
export function registerAudioProvider(provider: AudioProvider): void {
	audioProviders.set(provider.name, provider);
}

/**
 * Get an audio provider by name.
 *
 * - If `name` is provided, returns that specific provider (throws if not found).
 * - If `name` is omitted, returns the first configured provider (throws if none).
 */
export function getAudioProvider(name?: string): AudioProvider {
	if (name) {
		const provider = audioProviders.get(name);
		if (!provider) {
			const available = Array.from(audioProviders.keys()).join(", ");
			throw new VideoProviderError(
				`Audio provider "${name}" is not registered. Available: ${available || "(none)"}`,
				"PROVIDER_NOT_FOUND",
				name,
			);
		}
		return provider;
	}

	// No name given — return the first configured provider
	for (const provider of audioProviders.values()) {
		if (provider.isConfigured()) {
			return provider;
		}
	}

	// Nothing configured — throw a helpful error
	const available = Array.from(audioProviders.values())
		.map((p) => `  - ${p.name}: ${p.isConfigured() ? "configured" : "NOT configured"}`)
		.join("\n");

	throw new VideoProviderError(
		`No audio provider is configured.\nRegistered providers:\n${available || "  (none)"}`,
		"NO_CONFIGURED_PROVIDER",
		"audio-registry",
	);
}

/**
 * List all registered audio providers (with configuration status).
 */
export function listAudioProviders(): AudioProvider[] {
	return Array.from(audioProviders.values());
}

// ---------------------------------------------------------------------------
// Auto-register built-in providers
// ---------------------------------------------------------------------------

registerAudioProvider(new ElevenLabsProvider());
registerAudioProvider(new OpenRouterTTSProvider());
