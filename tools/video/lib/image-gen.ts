/**
 * Image generation module — generates still images via OpenRouter API.
 *
 * Uses Gemini 3.1 Flash Image (Nano Banana 2) model through OpenRouter.
 * The OpenRouter API uses the standard OpenAI chat completions format.
 * The model generates images inline as base64-encoded data in the response.
 *
 * Environment: OPENROUTER_API_KEY
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageGenerationOptions {
  /** Desired width in pixels. Not all models honour this; treated as a hint. */
  width?: number;
  /** Desired height in pixels. Not all models honour this; treated as a hint. */
  height?: number;
  /** Style modifier appended to the prompt (e.g. "photorealistic", "watercolor"). */
  style?: string;
  /** Override the default model. */
  model?: string;
  /** Override the API base URL (for testing). */
  apiBaseUrl?: string;
}

export interface ImageGenerationResult {
  /** The raw image data. */
  buffer: Buffer;
  /** MIME type of the generated image (e.g. "image/png"). */
  mimeType: string;
  /** The model that was actually used (from the response). */
  model: string;
  /** The prompt that was sent (including style modifier). */
  prompt: string;
}

/** Structured error for image generation failures. */
export class ImageGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: ImageGenerationErrorCode,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export type ImageGenerationErrorCode =
  | "MISSING_API_KEY"
  | "RATE_LIMITED"
  | "CONTENT_POLICY"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "API_ERROR"
  | "NO_IMAGE_IN_RESPONSE";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key.trim() === "") {
    throw new ImageGenerationError(
      "OPENROUTER_API_KEY environment variable is not set or empty.",
      "MISSING_API_KEY",
    );
  }
  return key.trim();
}

function buildPrompt(basePrompt: string, style?: string): string {
  const parts = ["Generate an image of:", basePrompt.trim()];
  if (style?.trim()) {
    parts.push(`Style: ${style.trim()}`);
  }
  return parts.join(" ");
}

/**
 * Extract base64 image data from the OpenRouter/OpenAI chat completion response.
 *
 * The response may contain image data in several formats:
 * 1. A content part with type "image_url" containing a data URI
 * 2. A content part with inline_data (Gemini-style)
 * 3. A text response containing a base64 block (fallback)
 */
function extractImageFromResponse(responseBody: unknown): {
  buffer: Buffer;
  mimeType: string;
} {
  const body = responseBody as Record<string, unknown>;

  // Navigate to the message content
  const choices = body.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) {
    throw new ImageGenerationError(
      "API response contains no choices.",
      "INVALID_RESPONSE",
    );
  }

  const message = choices[0].message as Record<string, unknown> | undefined;
  if (!message) {
    throw new ImageGenerationError(
      "API response choice has no message.",
      "INVALID_RESPONSE",
    );
  }

  const content = message.content;

  // Case 1: content is an array of parts (multimodal response)
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as Record<string, unknown>;

      // OpenAI-style image_url part
      if (p.type === "image_url") {
        const imageUrl = p.image_url as Record<string, unknown> | undefined;
        if (imageUrl?.url && typeof imageUrl?.url === "string") {
          return parseDataUri(imageUrl.url);
        }
      }

      // Gemini-style inline_data part
      if (p.type === "inline_data" || p.inline_data) {
        const inlineData = (p.inline_data ?? p) as Record<string, unknown>;
        if (inlineData.data && typeof inlineData.data === "string") {
          const mime =
            typeof inlineData.mime_type === "string"
              ? inlineData.mime_type
              : "image/png";
          return {
            buffer: Buffer.from(inlineData.data, "base64"),
            mimeType: mime,
          };
        }
      }
    }
  }

  // Case 2: content is a string — look for a data URI or raw base64
  if (typeof content === "string") {
    // Try data URI first
    const dataUriMatch = content.match(
      /data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)/,
    );
    if (dataUriMatch) {
      return {
        buffer: Buffer.from(dataUriMatch[2], "base64"),
        mimeType: dataUriMatch[1],
      };
    }

    // Try raw base64 block (very long base64 string)
    const base64Match = content.match(/([A-Za-z0-9+/=]{100,})/);
    if (base64Match) {
      return {
        buffer: Buffer.from(base64Match[1], "base64"),
        mimeType: "image/png",
      };
    }
  }

  throw new ImageGenerationError(
    "No image data found in API response. The model may have returned text only.",
    "NO_IMAGE_IN_RESPONSE",
  );
}

function parseDataUri(uri: string): { buffer: Buffer; mimeType: string } {
  const match = uri.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (!match) {
    throw new ImageGenerationError(
      `Invalid data URI format: ${uri.slice(0, 50)}...`,
      "INVALID_RESPONSE",
    );
  }
  return {
    buffer: Buffer.from(match[2], "base64"),
    mimeType: match[1],
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an image from a text prompt using Gemini 3.1 Flash Image via OpenRouter.
 *
 * @param prompt - The text description of the image to generate.
 * @param options - Optional configuration (dimensions, style, model override).
 * @returns The generated image as a Buffer with metadata.
 *
 * @throws {ImageGenerationError} On missing API key, rate limits, content policy
 *   violations, network errors, or invalid responses.
 *
 * @example
 * ```ts
 * const result = await generateImage("A sunset over the ocean with sailboats");
 * await fs.writeFile("sunset.png", result.buffer);
 * ```
 */
export async function generateImage(
  prompt: string,
  options: ImageGenerationOptions = {},
): Promise<ImageGenerationResult> {
  // Validate inputs
  if (!prompt || prompt.trim() === "") {
    throw new ImageGenerationError(
      "Prompt must be a non-empty string.",
      "API_ERROR",
    );
  }

  const apiKey = getApiKey();
  const model = options.model ?? DEFAULT_MODEL;
  const apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;
  const fullPrompt = buildPrompt(prompt, options.style);

  // Build the request body
  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: fullPrompt,
      },
    ],
  };

  // Add dimension hints if provided. These are model-specific and may be ignored.
  if (options.width || options.height) {
    requestBody.generation_config = {
      ...(options.width ? { width: options.width } : {}),
      ...(options.height ? { height: options.height } : {}),
    };
  }

  // Retry loop
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/anomalyco/randal",
          "X-Title": "Randal Video Tool",
        },
        body: JSON.stringify(requestBody),
      });

      // Handle HTTP errors
      if (!response.ok) {
        const status = response.status;
        let errorMessage: string;

        try {
          const errorBody = (await response.json()) as Record<string, unknown>;
          const errorObj = errorBody.error as Record<string, unknown> | undefined;
          errorMessage = (errorObj?.message as string) ?? JSON.stringify(errorBody);
        } catch {
          errorMessage = `HTTP ${status}: ${response.statusText}`;
        }

        // Rate limiting — retry with backoff
        if (status === 429) {
          if (attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
            await sleep(delay);
            continue;
          }
          throw new ImageGenerationError(
            `Rate limited after ${MAX_RETRIES + 1} attempts: ${errorMessage}`,
            "RATE_LIMITED",
            status,
          );
        }

        // Content policy violation — do not retry
        if (status === 400 && errorMessage.toLowerCase().includes("safety")) {
          throw new ImageGenerationError(
            `Content policy violation: ${errorMessage}`,
            "CONTENT_POLICY",
            status,
          );
        }

        // Other API errors
        throw new ImageGenerationError(
          `OpenRouter API error: ${errorMessage}`,
          "API_ERROR",
          status,
        );
      }

      const responseBody = await response.json();
      const { buffer, mimeType } = extractImageFromResponse(responseBody);

      // Basic sanity check — image should be more than a few bytes
      if (buffer.length < 100) {
        throw new ImageGenerationError(
          `Generated image is suspiciously small (${buffer.length} bytes). The model may have failed silently.`,
          "INVALID_RESPONSE",
        );
      }

      return {
        buffer,
        mimeType,
        model,
        prompt: fullPrompt,
      };
    } catch (error) {
      // If it's already our error type, rethrow (unless it's retriable)
      if (error instanceof ImageGenerationError) {
        if (
          error.code === "RATE_LIMITED" &&
          attempt < MAX_RETRIES
        ) {
          lastError = error;
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
          await sleep(delay);
          continue;
        }
        throw error;
      }

      // Network/fetch errors — retry
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        await sleep(delay);
        continue;
      }

      throw new ImageGenerationError(
        `Network error after ${MAX_RETRIES + 1} attempts: ${error instanceof Error ? error.message : String(error)}`,
        "NETWORK_ERROR",
        undefined,
        error,
      );
    }
  }

  // Should be unreachable, but TypeScript needs it
  throw new ImageGenerationError(
    `Failed after ${MAX_RETRIES + 1} attempts.`,
    "NETWORK_ERROR",
    undefined,
    lastError,
  );
}
