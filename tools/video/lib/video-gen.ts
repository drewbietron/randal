/**
 * Video generation module — generates video clips via Google AI Studio Veo API.
 *
 * Uses Google Veo (3.0 / 3.1) through the Gemini API. The API follows an
 * async submit-then-poll pattern:
 *
 * 1. POST to `predictLongRunning` → returns an operation name
 * 2. GET the operation periodically until `done: true`
 * 3. Extract the generated video data (base64 or download URL)
 *
 * Environment: GOOGLE_AI_STUDIO_KEY
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VeoAspectRatio = "16:9" | "9:16";
export type VeoDuration = 4 | 6 | 8;
export type VeoModel =
  | "veo-3.0-generate-001"
  | "veo-3.1-generate-preview";

export interface VideoGenerationOptions {
  /** Duration of the clip in seconds. Defaults to 8. */
  duration?: VeoDuration;
  /** Aspect ratio. Defaults to "16:9". */
  aspectRatio?: VeoAspectRatio;
  /** Reference image for image-to-video generation (first frame). */
  referenceImage?: Buffer;
  /** MIME type of the reference image. Defaults to "image/png". */
  referenceImageMimeType?: string;
  /** Model to use. Defaults to "veo-3.0-generate-001". */
  model?: VeoModel;
  /** Resolution. Defaults to "720p". */
  resolution?: "720p" | "1080p";
  /** Number of samples to generate. Defaults to 1. */
  sampleCount?: number;
  /** Maximum time to wait for generation in milliseconds. Defaults to 180000 (3 min). */
  timeoutMs?: number;
  /** Polling interval in milliseconds. Defaults to 5000 (5 seconds). */
  pollIntervalMs?: number;
  /** Override the API base URL (for testing). */
  apiBaseUrl?: string;
}

export interface VideoGenerationResult {
  /** The raw video data. */
  buffer: Buffer;
  /** MIME type of the generated video (e.g. "video/mp4"). */
  mimeType: string;
  /** The model that was used. */
  model: string;
  /** The prompt that was sent. */
  prompt: string;
  /** The operation name from the API. */
  operationName: string;
}

/** Structured error for video generation failures. */
export class VideoGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: VideoGenerationErrorCode,
    public readonly statusCode?: number,
    public readonly operationName?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VideoGenerationError";
  }
}

export type VideoGenerationErrorCode =
  | "MISSING_API_KEY"
  | "RATE_LIMITED"
  | "CONTENT_POLICY"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "API_ERROR"
  | "TIMEOUT"
  | "OPERATION_FAILED"
  | "NO_VIDEO_IN_RESPONSE";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL: VeoModel = "veo-3.0-generate-001";
const DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes
const DEFAULT_POLL_INTERVAL_MS = 5_000; // 5 seconds
const DEFAULT_DURATION: VeoDuration = 8;
const DEFAULT_ASPECT_RATIO: VeoAspectRatio = "16:9";
const DEFAULT_RESOLUTION = "720p";
const DEFAULT_SAMPLE_COUNT = 1;
const SUBMIT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.GOOGLE_AI_STUDIO_KEY;
  if (!key || key.trim() === "") {
    throw new VideoGenerationError(
      "GOOGLE_AI_STUDIO_KEY environment variable is not set or empty.",
      "MISSING_API_KEY",
    );
  }
  return key.trim();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// API interaction
// ---------------------------------------------------------------------------

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

/**
 * Submit a video generation request to the Veo API.
 * Returns the operation name for polling.
 */
async function submitGeneration(
  prompt: string,
  apiKey: string,
  options: VideoGenerationOptions,
): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;
  const apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;
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
          const errorObj = errorBody.error as Record<string, unknown> | undefined;
          errorMessage = (errorObj?.message as string) ?? JSON.stringify(errorBody);
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
          throw new VideoGenerationError(
            `Rate limited after ${SUBMIT_MAX_RETRIES + 1} attempts: ${errorMessage}`,
            "RATE_LIMITED",
            status,
          );
        }

        // Content policy
        if (
          status === 400 &&
          (errorMessage.toLowerCase().includes("safety") ||
            errorMessage.toLowerCase().includes("blocked"))
        ) {
          throw new VideoGenerationError(
            `Content policy violation: ${errorMessage}`,
            "CONTENT_POLICY",
            status,
          );
        }

        throw new VideoGenerationError(
          `Veo API error on submit: ${errorMessage}`,
          "API_ERROR",
          status,
        );
      }

      const body = (await response.json()) as VeoSubmitResponse;
      if (!body.name || typeof body.name !== "string") {
        throw new VideoGenerationError(
          "Veo API did not return an operation name.",
          "INVALID_RESPONSE",
        );
      }

      return body.name;
    } catch (error) {
      if (error instanceof VideoGenerationError) {
        throw error;
      }

      lastError = error;
      if (attempt < SUBMIT_MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        await sleep(delay);
        continue;
      }

      throw new VideoGenerationError(
        `Network error submitting to Veo after ${SUBMIT_MAX_RETRIES + 1} attempts: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "NETWORK_ERROR",
        undefined,
        undefined,
        error,
      );
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new VideoGenerationError(
    "Submit failed after retries.",
    "NETWORK_ERROR",
    undefined,
    undefined,
    lastError,
  );
}

/**
 * Poll an operation until it completes or times out.
 * Returns the final operation response.
 */
async function pollOperation(
  operationName: string,
  apiKey: string,
  options: VideoGenerationOptions,
): Promise<VeoOperationResponse> {
  const apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;
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
      throw new VideoGenerationError(
        `Video generation timed out after ${Math.round(elapsed / 1000)}s. Operation: ${operationName}`,
        "TIMEOUT",
        undefined,
        operationName,
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
          throw new VideoGenerationError(
            `Polling failed ${MAX_CONSECUTIVE_ERRORS} consecutive times. Last status: ${response.status}`,
            "API_ERROR",
            response.status,
            operationName,
          );
        }
        await sleep(pollIntervalMs);
        continue;
      }

      consecutiveErrors = 0;
      const body = (await response.json()) as VeoOperationResponse;

      // Check for operation-level errors
      if (body.error) {
        throw new VideoGenerationError(
          `Veo operation failed: [${body.error.code}] ${body.error.message}`,
          "OPERATION_FAILED",
          body.error.code,
          operationName,
        );
      }

      // If done, return
      if (body.done) {
        return body;
      }

      // Not done yet — wait and poll again
      await sleep(pollIntervalMs);
    } catch (error) {
      if (error instanceof VideoGenerationError) {
        throw error;
      }

      // Network error during polling — allow some retries
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new VideoGenerationError(
          `Polling failed due to ${MAX_CONSECUTIVE_ERRORS} consecutive network errors: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "NETWORK_ERROR",
          undefined,
          operationName,
          error,
        );
      }

      await sleep(pollIntervalMs);
    }
  }
}

/**
 * Extract video data from a completed operation response.
 */
function extractVideoFromOperation(
  operation: VeoOperationResponse,
): { buffer: Buffer; mimeType: string } {
  const response = operation.response;
  if (!response) {
    throw new VideoGenerationError(
      "Completed operation has no response body.",
      "INVALID_RESPONSE",
      undefined,
      operation.name,
    );
  }

  const samples = response.generatedSamples;
  if (!samples || samples.length === 0) {
    throw new VideoGenerationError(
      "Completed operation has no generated samples.",
      "NO_VIDEO_IN_RESPONSE",
      undefined,
      operation.name,
    );
  }

  const firstSample = samples[0];
  const video = firstSample.video;
  if (!video) {
    throw new VideoGenerationError(
      "First generated sample has no video data.",
      "NO_VIDEO_IN_RESPONSE",
      undefined,
      operation.name,
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
    // GCS URIs or HTTP URLs — for now, throw an error since we'd need
    // additional logic to download from GCS. The API typically returns
    // base64 for the sizes we request.
    throw new VideoGenerationError(
      `Video data is at a URI (${video.uri}) instead of inline base64. URI-based downloads are not yet supported.`,
      "INVALID_RESPONSE",
      undefined,
      operation.name,
    );
  }

  throw new VideoGenerationError(
    "First generated sample has no usable video data (no base64 or URI).",
    "NO_VIDEO_IN_RESPONSE",
    undefined,
    operation.name,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a video clip from a text prompt using Google Veo via AI Studio.
 *
 * This function submits a generation request, polls until completion, and
 * returns the video data. The entire process is asynchronous and may take
 * 30-120+ seconds depending on duration and model.
 *
 * @param prompt - The text description of the video to generate.
 * @param options - Optional configuration (duration, aspect ratio, reference image, etc.).
 * @returns The generated video as a Buffer with metadata.
 *
 * @throws {VideoGenerationError} On missing API key, rate limits, content policy
 *   violations, network errors, timeouts, or invalid responses.
 *
 * @example
 * ```ts
 * const result = await generateVideoClip("A drone shot flying over a mountain range at sunset");
 * await fs.writeFile("mountain-flyover.mp4", result.buffer);
 * ```
 *
 * @example
 * ```ts
 * // Image-to-video: use a reference image as the first frame
 * const imageBuffer = await fs.readFile("./first-frame.png");
 * const result = await generateVideoClip("Camera slowly zooms out revealing the landscape", {
 *   referenceImage: imageBuffer,
 *   duration: 6,
 *   aspectRatio: "16:9",
 * });
 * ```
 */
export async function generateVideoClip(
  prompt: string,
  options: VideoGenerationOptions = {},
): Promise<VideoGenerationResult> {
  // Validate inputs
  if (!prompt || prompt.trim() === "") {
    throw new VideoGenerationError(
      "Prompt must be a non-empty string.",
      "API_ERROR",
    );
  }

  if (options.duration !== undefined && ![4, 6, 8].includes(options.duration)) {
    throw new VideoGenerationError(
      `Invalid duration: ${options.duration}. Must be 4, 6, or 8 seconds.`,
      "API_ERROR",
    );
  }

  if (
    options.aspectRatio !== undefined &&
    !["16:9", "9:16"].includes(options.aspectRatio)
  ) {
    throw new VideoGenerationError(
      `Invalid aspect ratio: ${options.aspectRatio}. Must be "16:9" or "9:16".`,
      "API_ERROR",
    );
  }

  const apiKey = getApiKey();
  const model = options.model ?? DEFAULT_MODEL;

  // Step 1: Submit the generation request
  const operationName = await submitGeneration(prompt, apiKey, options);

  // Step 2: Poll until done
  const operation = await pollOperation(operationName, apiKey, options);

  // Step 3: Extract the video data
  const { buffer, mimeType } = extractVideoFromOperation(operation);

  // Sanity check
  if (buffer.length < 1000) {
    throw new VideoGenerationError(
      `Generated video is suspiciously small (${buffer.length} bytes). The model may have failed silently.`,
      "INVALID_RESPONSE",
      undefined,
      operationName,
    );
  }

  return {
    buffer,
    mimeType,
    model,
    prompt: prompt.trim(),
    operationName,
  };
}

/**
 * Check the status of a previously submitted video generation operation.
 *
 * Useful for monitoring progress without blocking.
 *
 * @param operationName - The operation name returned from a previous submission.
 * @returns Status information about the operation.
 */
export async function checkOperationStatus(
  operationName: string,
  options: { apiBaseUrl?: string } = {},
): Promise<{
  done: boolean;
  error?: { code: number; message: string };
  metadata?: Record<string, unknown>;
}> {
  const apiKey = getApiKey();
  const apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;

  const operationPath = operationName.startsWith("operations/")
    ? operationName
    : `operations/${operationName}`;
  const url = `${apiBase}/${operationPath}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-goog-api-key": apiKey,
    },
  });

  if (!response.ok) {
    throw new VideoGenerationError(
      `Failed to check operation status: HTTP ${response.status}`,
      "API_ERROR",
      response.status,
      operationName,
    );
  }

  const body = (await response.json()) as VeoOperationResponse;

  return {
    done: body.done ?? false,
    error: body.error,
    metadata: body.metadata,
  };
}
