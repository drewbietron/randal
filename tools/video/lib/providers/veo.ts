/**
 * Veo video provider — generates video clips via Google AI Studio Veo API.
 *
 * Uses Google Veo (3.0 / 3.1) through the Gemini API. The API follows an
 * async submit-then-poll pattern:
 *
 * 1. POST to `predictLongRunning` -> returns an operation name
 * 2. GET the operation periodically until `done: true`
 * 3. Extract the generated video data (base64 or download URL)
 *
 * Environment: GOOGLE_AI_STUDIO_KEY
 */

import type {
  VideoProvider,
  GenerateClipOptions,
  GenerateClipResult,
} from "./types";
import { VideoProviderError } from "./types";

// ---------------------------------------------------------------------------
// Veo-specific types
// ---------------------------------------------------------------------------

export type VeoModel =
  | "veo-3.0-generate-001"
  | "veo-3.1-generate-preview";

interface VeoSubmitResponse {
  /** The operation resource name, e.g. "operations/xyz". */
  name: string;
}

interface VeoOperationResponse {
  name: string;
  done?: boolean;
  error?: {
    code: number;
    message: string;
    status?: string;
  };
  metadata?: Record<string, unknown>;
  response?: {
    /** Array of generated video objects. */
    generatedSamples?: Array<{
      video?: {
        /** Base64-encoded video data. */
        bytesBase64Encoded?: string;
        /** GCS URI for the video (some endpoints). */
        uri?: string;
        /** MIME type. */
        mimeType?: string;
      };
    }>;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL: VeoModel = "veo-3.0-generate-001";
const DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const DEFAULT_POLL_INTERVAL_MS = 5_000; // 5 seconds
const DEFAULT_DURATION = 8;
const DEFAULT_ASPECT_RATIO = "16:9";
const DEFAULT_RESOLUTION = "720p";
const DEFAULT_SAMPLE_COUNT = 1;
const SUBMIT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// VeoProvider class
// ---------------------------------------------------------------------------

export class VeoProvider implements VideoProvider {
  readonly name = "veo";
  readonly description = "Google Veo — generate video clips via AI Studio (Veo 3.0 / 3.1)";
  readonly models: string[] = ["veo-3.0-generate-001", "veo-3.1-generate-preview"];

  private apiBaseUrl?: string;

  constructor(options?: { apiBaseUrl?: string }) {
    this.apiBaseUrl = options?.apiBaseUrl;
  }

  isConfigured(): boolean {
    const key = process.env.GOOGLE_AI_STUDIO_KEY;
    return typeof key === "string" && key.trim() !== "";
  }

  private getApiKey(): string {
    const key = process.env.GOOGLE_AI_STUDIO_KEY;
    if (!key || key.trim() === "") {
      throw new VideoProviderError(
        "GOOGLE_AI_STUDIO_KEY environment variable is not set or empty.",
        "MISSING_API_KEY",
        this.name,
      );
    }
    return key.trim();
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  async generateClip(
    prompt: string,
    options: GenerateClipOptions = {},
  ): Promise<GenerateClipResult> {
    // Validate inputs
    if (!prompt || prompt.trim() === "") {
      throw new VideoProviderError(
        "Prompt must be a non-empty string.",
        "API_ERROR",
        this.name,
      );
    }

    if (options.duration !== undefined && ![4, 6, 8].includes(options.duration)) {
      throw new VideoProviderError(
        `Invalid duration: ${options.duration}. Must be 4, 6, or 8 seconds.`,
        "API_ERROR",
        this.name,
      );
    }

    if (
      options.aspectRatio !== undefined &&
      !["16:9", "9:16"].includes(options.aspectRatio)
    ) {
      throw new VideoProviderError(
        `Invalid aspect ratio: ${options.aspectRatio}. Must be "16:9" or "9:16".`,
        "API_ERROR",
        this.name,
      );
    }

    const apiKey = this.getApiKey();
    const model =
      (options.providerOptions?.model as VeoModel | undefined) ?? DEFAULT_MODEL;

    // Step 1: Submit the generation request
    const operationName = await this.submitGeneration(prompt, apiKey, model, options);

    // Step 2: Poll until done
    const operation = await this.pollOperation(operationName, apiKey, options);

    // Step 3: Extract the video data
    const { buffer, mimeType } = this.extractVideoFromOperation(operation);

    // Sanity check
    if (buffer.length < 1000) {
      throw new VideoProviderError(
        `Generated video is suspiciously small (${buffer.length} bytes). The model may have failed silently.`,
        "INVALID_RESPONSE",
        this.name,
      );
    }

    return {
      buffer,
      mimeType,
      model,
      prompt: prompt.trim(),
      metadata: {
        provider: this.name,
        operationName,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  private async submitGeneration(
    prompt: string,
    apiKey: string,
    model: VeoModel,
    options: GenerateClipOptions,
  ): Promise<string> {
    const apiBase = this.apiBaseUrl ?? DEFAULT_API_BASE;
    const url = `${apiBase}/models/${model}:predictLongRunning`;

    // Build the request body
    const instance: Record<string, unknown> = { prompt };

    // Add reference image for image-to-video
    if (options.referenceImage) {
      instance.image = {
        bytesBase64Encoded: options.referenceImage.toString("base64"),
        mimeType: options.referenceImageMimeType ?? "image/png",
      };
    }

    const parameters: Record<string, unknown> = {
      aspectRatio: options.aspectRatio ?? DEFAULT_ASPECT_RATIO,
      durationSeconds: options.duration ?? DEFAULT_DURATION,
      resolution: options.resolution ?? DEFAULT_RESOLUTION,
      sampleCount: options.sampleCount ?? DEFAULT_SAMPLE_COUNT,
    };

    const requestBody = {
      instances: [instance],
      parameters,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= SUBMIT_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const status = response.status;
          let errorMessage: string;

          try {
            const errorBody = (await response.json()) as Record<string, unknown>;
            const errorObj = errorBody.error as
              | Record<string, unknown>
              | undefined;
            errorMessage =
              (errorObj?.message as string) ?? JSON.stringify(errorBody);
          } catch {
            errorMessage = `HTTP ${status}: ${response.statusText}`;
          }

          // Rate limiting — retry with backoff
          if (status === 429) {
            if (attempt < SUBMIT_MAX_RETRIES) {
              const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
              await sleep(delay);
              continue;
            }
            throw new VideoProviderError(
              `Rate limited after ${SUBMIT_MAX_RETRIES + 1} attempts: ${errorMessage}`,
              "RATE_LIMITED",
              this.name,
              status,
            );
          }

          // Content policy
          if (
            status === 400 &&
            (errorMessage.toLowerCase().includes("safety") ||
              errorMessage.toLowerCase().includes("blocked"))
          ) {
            throw new VideoProviderError(
              `Content policy violation: ${errorMessage}`,
              "CONTENT_POLICY",
              this.name,
              status,
            );
          }

          throw new VideoProviderError(
            `Veo API error on submit: ${errorMessage}`,
            "API_ERROR",
            this.name,
            status,
          );
        }

        const body = (await response.json()) as VeoSubmitResponse;
        if (!body.name || typeof body.name !== "string") {
          throw new VideoProviderError(
            "Veo API did not return an operation name.",
            "INVALID_RESPONSE",
            this.name,
          );
        }

        return body.name;
      } catch (error) {
        if (error instanceof VideoProviderError) {
          throw error;
        }

        lastError = error;
        if (attempt < SUBMIT_MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
          await sleep(delay);
          continue;
        }

        throw new VideoProviderError(
          `Network error submitting to Veo after ${SUBMIT_MAX_RETRIES + 1} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "NETWORK_ERROR",
          this.name,
          undefined,
          error,
        );
      }
    }

    // Unreachable, but satisfies TypeScript
    throw new VideoProviderError(
      "Submit failed after retries.",
      "NETWORK_ERROR",
      this.name,
      undefined,
      lastError,
    );
  }

  // -------------------------------------------------------------------------
  // Poll
  // -------------------------------------------------------------------------

  private async pollOperation(
    operationName: string,
    apiKey: string,
    options: GenerateClipOptions,
  ): Promise<VeoOperationResponse> {
    const apiBase = this.apiBaseUrl ?? DEFAULT_API_BASE;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Construct the poll URL. The operationName may or may not include the
    // "operations/" prefix — handle both.
    const operationPath = operationName.startsWith("operations/")
      ? operationName
      : `operations/${operationName}`;
    const url = `${apiBase}/${operationPath}`;

    const startTime = Date.now();
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        throw new VideoProviderError(
          `Video generation timed out after ${Math.round(elapsed / 1000)}s. Operation: ${operationName}`,
          "TIMEOUT",
          this.name,
        );
      }

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "x-goog-api-key": apiKey,
          },
        });

        if (!response.ok) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw new VideoProviderError(
              `Polling failed ${MAX_CONSECUTIVE_ERRORS} consecutive times. Last status: ${response.status}`,
              "API_ERROR",
              this.name,
              response.status,
            );
          }
          await sleep(pollIntervalMs);
          continue;
        }

        consecutiveErrors = 0;
        const body = (await response.json()) as VeoOperationResponse;

        // Check for operation-level errors
        if (body.error) {
          throw new VideoProviderError(
            `Veo operation failed: [${body.error.code}] ${body.error.message}`,
            "OPERATION_FAILED",
            this.name,
            body.error.code,
          );
        }

        // If done, return
        if (body.done) {
          return body;
        }

        // Not done yet — wait and poll again
        await sleep(pollIntervalMs);
      } catch (error) {
        if (error instanceof VideoProviderError) {
          throw error;
        }

        // Network error during polling — allow some retries
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new VideoProviderError(
            `Polling failed due to ${MAX_CONSECUTIVE_ERRORS} consecutive network errors: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "NETWORK_ERROR",
            this.name,
            undefined,
            error,
          );
        }

        await sleep(pollIntervalMs);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Extract
  // -------------------------------------------------------------------------

  private extractVideoFromOperation(
    operation: VeoOperationResponse,
  ): { buffer: Buffer; mimeType: string } {
    const response = operation.response;
    if (!response) {
      throw new VideoProviderError(
        "Completed operation has no response body.",
        "INVALID_RESPONSE",
        this.name,
      );
    }

    const samples = response.generatedSamples;
    if (!samples || samples.length === 0) {
      throw new VideoProviderError(
        "Completed operation has no generated samples.",
        "NO_VIDEO_IN_RESPONSE",
        this.name,
      );
    }

    const firstSample = samples[0];
    const video = firstSample.video;
    if (!video) {
      throw new VideoProviderError(
        "First generated sample has no video data.",
        "NO_VIDEO_IN_RESPONSE",
        this.name,
      );
    }

    // Try base64-encoded bytes first
    if (video.bytesBase64Encoded) {
      return {
        buffer: Buffer.from(video.bytesBase64Encoded, "base64"),
        mimeType: video.mimeType ?? "video/mp4",
      };
    }

    // If there's a URI, we need to fetch it
    if (video.uri) {
      throw new VideoProviderError(
        `Video data is at a URI (${video.uri}) instead of inline base64. URI-based downloads are not yet supported.`,
        "INVALID_RESPONSE",
        this.name,
      );
    }

    throw new VideoProviderError(
      "First generated sample has no usable video data (no base64 or URI).",
      "NO_VIDEO_IN_RESPONSE",
      this.name,
    );
  }
}
