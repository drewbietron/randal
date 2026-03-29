/**
 * Veo video provider — generates video clips via Google Veo API.
 *
 * Supports two backends:
 *   1. **Vertex AI** (preferred) — requires VERTEX_AI_API_KEY + GOOGLE_CLOUD_PROJECT
 *   2. **AI Studio** (fallback)  — requires GOOGLE_AI_STUDIO_KEY
 *
 * The backend is auto-detected based on which environment variables are set.
 * When both are configured, Vertex AI is preferred.
 *
 * Both backends use an async submit-then-poll pattern:
 *
 *   1. POST to `predictLongRunning` → returns an operation name
 *   2. Poll the operation until `done: true`
 *   3. Extract the generated video data (base64)
 *
 * Key differences between backends:
 *   - Vertex AI polls via POST to `fetchPredictOperation` with operation name in body
 *   - AI Studio polls via GET to `operations/{id}`
 *   - Vertex AI returns `response.videos[]` instead of `response.generatedSamples[]`
 *   - Vertex AI requires `generateAudio: true` for Veo 3+ models
 */

import type { GenerateClipOptions, GenerateClipResult, VideoProvider } from "./types";
import { VideoProviderError } from "./types";

// ---------------------------------------------------------------------------
// Veo-specific types
// ---------------------------------------------------------------------------

export type VeoBackend = "vertex" | "ai-studio";

export type VeoModel =
	| "veo-3.0-generate-001"
	| "veo-3.0-fast-generate-001"
	| "veo-3.1-generate-001"
	| "veo-3.1-fast-generate-001"
	| "veo-3.1-generate-preview"
	| "veo-3.1-fast-generate-preview";

interface VeoSubmitResponse {
	/** The operation resource name, e.g. "operations/xyz" or a full Vertex AI path. */
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
		/** AI Studio: array of generated video objects. */
		generatedSamples?: Array<{
			video?: {
				bytesBase64Encoded?: string;
				uri?: string;
				mimeType?: string;
			};
		}>;
		/** Vertex AI: array of generated video objects. */
		videos?: Array<{
			bytesBase64Encoded?: string;
			gcsUri?: string;
			mimeType?: string;
		}>;
		[key: string]: unknown;
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL: VeoModel = "veo-3.0-generate-001";

const AI_STUDIO_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VERTEX_AI_LOCATION = "us-central1";

const AI_STUDIO_TIMEOUT_MS = 180_000; // 3 minutes
const VERTEX_AI_TIMEOUT_MS = 300_000; // 5 minutes

const AI_STUDIO_POLL_INTERVAL_MS = 5_000; // 5 seconds
const VERTEX_AI_POLL_INTERVAL_MS = 15_000; // 15 seconds

const DEFAULT_DURATION = 8;
const DEFAULT_ASPECT_RATIO = "16:9";
const DEFAULT_RESOLUTION = "720p";
const DEFAULT_SAMPLE_COUNT = 1;
const SUBMIT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;

const AI_STUDIO_MODELS: VeoModel[] = ["veo-3.0-generate-001", "veo-3.1-generate-preview"];

const VERTEX_AI_MODELS: VeoModel[] = [
	"veo-3.0-generate-001",
	"veo-3.0-fast-generate-001",
	"veo-3.1-generate-001",
	"veo-3.1-fast-generate-001",
	"veo-3.1-generate-preview",
	"veo-3.1-fast-generate-preview",
];

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
	readonly description = "Google Veo — generate video clips (Vertex AI or AI Studio)";

	/** Exposed model list is determined at construction based on detected backend. */
	readonly models: string[];

	private backend: VeoBackend | null;

	constructor() {
		this.backend = this.detectBackend();
		this.models = this.backend === "vertex" ? [...VERTEX_AI_MODELS] : [...AI_STUDIO_MODELS];
	}

	/**
	 * Returns true if at least one backend is configured.
	 */
	isConfigured(): boolean {
		// Vertex AI
		const vertexKey = process.env.VERTEX_AI_API_KEY;
		const projectId = process.env.GOOGLE_CLOUD_PROJECT;
		if (vertexKey?.trim() && projectId && projectId.trim()) {
			return true;
		}
		// AI Studio
		const aiStudioKey = process.env.GOOGLE_AI_STUDIO_KEY;
		if (aiStudioKey?.trim()) {
			return true;
		}
		return false;
	}

	/**
	 * Detect which backend to use. Prefers Vertex AI when both are configured.
	 */
	private detectBackend(): VeoBackend | null {
		const vertexKey = process.env.VERTEX_AI_API_KEY;
		const projectId = process.env.GOOGLE_CLOUD_PROJECT;
		if (vertexKey?.trim() && projectId && projectId.trim()) {
			return "vertex";
		}
		const aiStudioKey = process.env.GOOGLE_AI_STUDIO_KEY;
		if (aiStudioKey?.trim()) {
			return "ai-studio";
		}
		return null;
	}

	/**
	 * Returns the backend, throwing if none is configured.
	 * Use this in any method that requires an active backend at call time.
	 */
	private requireBackend(): VeoBackend {
		if (!this.backend) {
			throw new VideoProviderError(
				"No Veo API key configured. Set VERTEX_AI_API_KEY + GOOGLE_CLOUD_PROJECT for Vertex AI, or GOOGLE_AI_STUDIO_KEY for AI Studio.",
				"MISSING_API_KEY",
				"veo",
			);
		}
		return this.backend;
	}

	/**
	 * Returns the other backend if it's configured, or null.
	 * Used for fallback when the primary backend returns auth errors.
	 */
	private getAlternateBackend(): VeoBackend | null {
		if (!this.backend) return null;

		if (this.backend === "vertex") {
			const aiStudioKey = process.env.GOOGLE_AI_STUDIO_KEY;
			return aiStudioKey?.trim() ? "ai-studio" : null;
		}
		// backend is "ai-studio" — check if Vertex is available
		const vertexKey = process.env.VERTEX_AI_API_KEY;
		const projectId = process.env.GOOGLE_CLOUD_PROJECT;
		return vertexKey?.trim() && projectId?.trim() ? "vertex" : null;
	}

	/**
	 * Returns the API key for a specific backend.
	 */
	private getApiKeyForBackend(backend: VeoBackend): string {
		if (backend === "vertex") {
			const key = process.env.VERTEX_AI_API_KEY;
			if (!key || key.trim() === "") {
				throw new VideoProviderError(
					"VERTEX_AI_API_KEY environment variable is not set or empty.",
					"MISSING_API_KEY",
					this.name,
				);
			}
			return key.trim();
		}
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

	/**
	 * Returns the API key for the active backend.
	 */
	private getApiKey(): string {
		return this.getApiKeyForBackend(this.requireBackend());
	}

	// -------------------------------------------------------------------------
	// Public
	// -------------------------------------------------------------------------

	async generateClip(
		prompt: string,
		options: GenerateClipOptions = {},
	): Promise<GenerateClipResult> {
		if (!prompt || prompt.trim() === "") {
			throw new VideoProviderError("Prompt must be a non-empty string.", "API_ERROR", this.name);
		}

		if (options.duration !== undefined && ![4, 6, 8].includes(options.duration)) {
			throw new VideoProviderError(
				`Invalid duration: ${options.duration}. Must be 4, 6, or 8 seconds.`,
				"API_ERROR",
				this.name,
			);
		}

		if (options.aspectRatio !== undefined && !["16:9", "9:16"].includes(options.aspectRatio)) {
			throw new VideoProviderError(
				`Invalid aspect ratio: ${options.aspectRatio}. Must be "16:9" or "9:16".`,
				"API_ERROR",
				this.name,
			);
		}

		const primaryBackend = this.requireBackend();
		const model = (options.providerOptions?.model as VeoModel | undefined) ?? DEFAULT_MODEL;

		// Try primary backend
		try {
			return await this.executeOnBackend(prompt, model, options, primaryBackend);
		} catch (error) {
			// Only fallback on auth errors (401/403) from submit
			if (
				error instanceof VideoProviderError &&
				error.statusCode != null &&
				(error.statusCode === 401 || error.statusCode === 403)
			) {
				const alternate = this.getAlternateBackend();
				if (alternate) {
					// Check model compatibility with fallback backend
					const alternateModels = alternate === "vertex" ? VERTEX_AI_MODELS : AI_STUDIO_MODELS;
					if (!alternateModels.includes(model)) {
						throw new VideoProviderError(
							`Auth failed on ${primaryBackend} (${error.statusCode}), ` +
								`but model "${model}" is not available on fallback backend ${alternate}. ` +
								`Available models on ${alternate}: ${alternateModels.join(", ")}`,
							"API_ERROR",
							this.name,
							error.statusCode,
						);
					}

					console.error(
						`[veo] ${primaryBackend} auth failed (${error.statusCode}), ` +
							`falling back to ${alternate}...`,
					);
					return await this.executeOnBackend(prompt, model, options, alternate);
				}
			}
			throw error; // Not a fallback-worthy error, or no alternate available
		}
	}

	/**
	 * Execute the full submit → poll → extract flow on a specific backend.
	 */
	private async executeOnBackend(
		prompt: string,
		model: VeoModel,
		options: GenerateClipOptions,
		backend: VeoBackend,
	): Promise<GenerateClipResult> {
		const apiKey = this.getApiKeyForBackend(backend);

		// Step 1: Submit
		const operationName = await this.submitGeneration(prompt, apiKey, model, options, backend);

		// Step 2: Poll
		const operation = await this.pollOperation(operationName, apiKey, model, options, backend);

		// Step 3: Extract
		const { buffer, mimeType } = this.extractVideoFromOperation(operation, backend);

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
				backend,
				operationName,
				usedFallback: backend !== this.backend,
			},
		};
	}

	// -------------------------------------------------------------------------
	// Submit
	// -------------------------------------------------------------------------

	private buildSubmitUrl(model: VeoModel, backend: VeoBackend): string {
		if (backend === "vertex") {
			const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
			return `https://${VERTEX_AI_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_AI_LOCATION}/publishers/google/models/${model}:predictLongRunning`;
		}
		return `${AI_STUDIO_API_BASE}/models/${model}:predictLongRunning`;
	}

	private async submitGeneration(
		prompt: string,
		apiKey: string,
		model: VeoModel,
		options: GenerateClipOptions,
		backend: VeoBackend,
	): Promise<string> {
		const url = this.buildSubmitUrl(model, backend);

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

		// Vertex AI requires generateAudio for Veo 3+ models
		if (backend === "vertex") {
			parameters.generateAudio = true;
		}

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
						`Veo API error on submit (${backend}): ${errorMessage}`,
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
					`Network error submitting to Veo (${backend}) after ${SUBMIT_MAX_RETRIES + 1} attempts: ${
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

	/**
	 * Build the poll URL and request options based on the specified backend.
	 *
	 * - AI Studio:  GET  `{base}/operations/{id}`
	 * - Vertex AI:  POST `{base}/.../models/{model}:fetchPredictOperation`
	 *               with `{ "operationName": "..." }` in body
	 */
	private buildPollRequest(
		operationName: string,
		apiKey: string,
		model: VeoModel,
		backend: VeoBackend,
	): { url: string; init: RequestInit } {
		if (backend === "vertex") {
			const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
			const url = `https://${VERTEX_AI_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_AI_LOCATION}/publishers/google/models/${model}:fetchPredictOperation`;
			return {
				url,
				init: {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-goog-api-key": apiKey,
					},
					body: JSON.stringify({ operationName }),
				},
			};
		}

		// AI Studio: GET with the operation path
		const operationPath = operationName.startsWith("operations/")
			? operationName
			: `operations/${operationName}`;
		const url = `${AI_STUDIO_API_BASE}/${operationPath}`;
		return {
			url,
			init: {
				method: "GET",
				headers: {
					"x-goog-api-key": apiKey,
				},
			},
		};
	}

	private async pollOperation(
		operationName: string,
		apiKey: string,
		model: VeoModel,
		options: GenerateClipOptions,
		backend: VeoBackend,
	): Promise<VeoOperationResponse> {
		const timeoutMs =
			options.timeoutMs ?? (backend === "vertex" ? VERTEX_AI_TIMEOUT_MS : AI_STUDIO_TIMEOUT_MS);
		const pollIntervalMs =
			options.pollIntervalMs ??
			(backend === "vertex" ? VERTEX_AI_POLL_INTERVAL_MS : AI_STUDIO_POLL_INTERVAL_MS);

		const startTime = Date.now();
		let consecutiveErrors = 0;
		const MAX_CONSECUTIVE_ERRORS = 5;

		while (true) {
			const elapsed = Date.now() - startTime;
			if (elapsed >= timeoutMs) {
				throw new VideoProviderError(
					`Video generation timed out after ${Math.round(elapsed / 1000)}s (${backend}). Operation: ${operationName}`,
					"TIMEOUT",
					this.name,
				);
			}

			try {
				const { url, init } = this.buildPollRequest(operationName, apiKey, model, backend);
				const response = await fetch(url, init);

				if (!response.ok) {
					consecutiveErrors++;
					if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
						throw new VideoProviderError(
							`Polling failed ${MAX_CONSECUTIVE_ERRORS} consecutive times (${backend}). Last status: ${response.status}`,
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
						`Veo operation failed (${backend}): [${body.error.code}] ${body.error.message}`,
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
						`Polling failed due to ${MAX_CONSECUTIVE_ERRORS} consecutive network errors (${backend}): ${
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
		backend: VeoBackend,
	): {
		buffer: Buffer;
		mimeType: string;
	} {
		const response = operation.response;
		if (!response) {
			throw new VideoProviderError(
				"Completed operation has no response body.",
				"INVALID_RESPONSE",
				this.name,
			);
		}

		// Vertex AI format: response.videos[]
		if (backend === "vertex") {
			return this.extractVertexVideo(response);
		}

		// AI Studio format: response.generatedSamples[]
		return this.extractAiStudioVideo(response);
	}

	/**
	 * Extract video data from a Vertex AI response.
	 * Vertex AI returns `response.videos[]` with `bytesBase64Encoded` or `gcsUri`.
	 */
	private extractVertexVideo(response: NonNullable<VeoOperationResponse["response"]>): {
		buffer: Buffer;
		mimeType: string;
	} {
		const videos = response.videos as
			| Array<{ bytesBase64Encoded?: string; gcsUri?: string; mimeType?: string }>
			| undefined;

		if (!videos || videos.length === 0) {
			throw new VideoProviderError(
				"Completed Vertex AI operation has no videos in response.",
				"NO_VIDEO_IN_RESPONSE",
				this.name,
			);
		}

		const firstVideo = videos[0];

		if (firstVideo.bytesBase64Encoded) {
			return {
				buffer: Buffer.from(firstVideo.bytesBase64Encoded, "base64"),
				mimeType: firstVideo.mimeType ?? "video/mp4",
			};
		}

		if (firstVideo.gcsUri) {
			throw new VideoProviderError(
				`Video data is at a GCS URI (${firstVideo.gcsUri}) instead of inline base64. GCS URI downloads are not yet supported.`,
				"INVALID_RESPONSE",
				this.name,
			);
		}

		throw new VideoProviderError(
			"First Vertex AI video has no usable data (no base64 or GCS URI).",
			"NO_VIDEO_IN_RESPONSE",
			this.name,
		);
	}

	/**
	 * Extract video data from an AI Studio response.
	 * AI Studio returns `response.generatedSamples[].video.bytesBase64Encoded`.
	 */
	private extractAiStudioVideo(response: NonNullable<VeoOperationResponse["response"]>): {
		buffer: Buffer;
		mimeType: string;
	} {
		const samples = response.generatedSamples;
		if (!samples || samples.length === 0) {
			throw new VideoProviderError(
				"Completed AI Studio operation has no generated samples.",
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

		if (video.bytesBase64Encoded) {
			return {
				buffer: Buffer.from(video.bytesBase64Encoded, "base64"),
				mimeType: video.mimeType ?? "video/mp4",
			};
		}

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
