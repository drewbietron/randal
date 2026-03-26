/**
 * Video provider registry — register, select, and list video generation providers.
 *
 * Built-in providers are auto-registered on import. Third-party providers can
 * be registered at runtime via `registerProvider()`.
 */

import type { VideoProvider } from "./types";
import { VideoProviderError } from "./types";
import { VeoProvider } from "./veo";
import { MockProvider } from "./mock";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const providers = new Map<string, VideoProvider>();

/**
 * Register a video provider. Overwrites any existing provider with the same name.
 */
export function registerProvider(provider: VideoProvider): void {
  providers.set(provider.name, provider);
}

/**
 * Get a provider by name.
 *
 * - If `name` is provided, returns that specific provider (throws if not found).
 * - If `name` is omitted, returns the first configured provider (throws if none).
 */
export function getProvider(name?: string): VideoProvider {
  if (name) {
    const provider = providers.get(name);
    if (!provider) {
      const available = Array.from(providers.keys()).join(", ");
      throw new VideoProviderError(
        `Video provider "${name}" is not registered. Available: ${available || "(none)"}`,
        "PROVIDER_NOT_FOUND",
        name,
      );
    }
    return provider;
  }

  // No name given — return the first configured provider
  const allProviders = Array.from(providers.values());
  for (const provider of allProviders) {
    if (provider.isConfigured()) {
      return provider;
    }
  }

  // Nothing configured — throw a helpful error
  const available = allProviders
    .map((p) => `  - ${p.name}: ${p.isConfigured() ? "configured" : "NOT configured"}`)
    .join("\n");

  throw new VideoProviderError(
    `No video provider is configured. Set the appropriate API key.\nRegistered providers:\n${available || "  (none)"}`,
    "NO_CONFIGURED_PROVIDER",
    "registry",
  );
}

/**
 * List all registered providers (with configuration status).
 */
export function listProviders(): VideoProvider[] {
  return Array.from(providers.values());
}

// ---------------------------------------------------------------------------
// Auto-register built-in providers
// ---------------------------------------------------------------------------

registerProvider(new VeoProvider());
registerProvider(new MockProvider());
