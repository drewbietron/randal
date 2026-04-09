/**
 * fal.ai video provider — generates video clips via fal.ai's hosted models.
 *
 * Supports Veo 3, Kling, and other video models through fal.ai's queue-based API.
 * Environment: FAL_KEY
 *
 * API pattern:
 *   1. POST to queue endpoint → returns request_id
 *   2. Poll status until COMPLETED
 *   3. Fetch result with video URL
 *   4. Download video buffer
 */

import type { GenerateClipOptions, GenerateClipResult, VideoProvider } from "./types";
import { VideoProviderError } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://queue.fal.run";
const DEFAULT_MODEL = "fal-ai/veo3/fast";
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 300_000; // 5 minutes
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;

const SUPPORTED_MODELS = [
	"fal-ai/veo3",
	"fal-ai/veo3/fast",
	"fal-ai/bytedance/seedance/v1.5/pro/text-to-video",
	"fal-ai/bytedance/seedance/v1/pro/fast/text-to-video",
	"fal-ai/bytedance/seedance/v1/pro/fast/image-to-video",
	"fal-ai/kling-video/v2.1/master",
	"fal-ai/kling-video/v2.1/standard",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FalQueueResponse {
	request_id: string;
	status?: string;
	response_url?: string;
	status_url?: string;
	cancel_url?: string;
	queue_position?: number;
}

interface FalStatusResponse {
	status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
	error?: string;
	logs?: Array<{ message: string; timestamp: string }>;
}

interface FalResultResponse {
	video?: {
		url: string;
		content_type?: string;
	};
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// FalProvider class
// ---------------------------------------------------------------------------

export class FalProvider implements VideoProvider {
	readonly name = "fal";
	readonly description = "fal.ai — video generation via hosted models (Veo 3, Kling, etc.)";
	readonly models = [...SUPPORTED_MODELS];

	isConfigured(): boolean {
		const key = process.env.FAL_KEY;
		return !!key?.trim();
	}

	private getApiKey(): string {
		const key = process.env.FAL_KEY;
		if (!key || key.trim() === "") {
			throw new VideoProviderError(
				"FAL_KEY environment variable is not set or empty.",
				"MISSING_API_KEY",
				this.name,
			);
		}
		return key.trim();
	}

	/**
	 * Get the base model path for queue status/result URLs.
	 * fal.ai uses the first 2 path segments of the model ID for queue tracking.
	 * e.g. "fal-ai/veo3/fast" -> "fal-ai/veo3"
	 * e.g. "fal-ai/bytedance/seedance/v1.5/pro/text-to-video" -> "fal-ai/bytedance"
	 */
	private getQueueModelPath(model: string): string {
		const segments = model.split("/");
		return segments.slice(0, 2).join("/");
	}

	async generateClip(
		prompt: string,
		options: GenerateClipOptions = {},
	): Promise<GenerateClipResult> {
		if (!prompt || prompt.trim() === "") {
			throw new VideoProviderError("Prompt must be a non-empty string.", "API_ERROR", this.name);
		}

		const apiKey = this.getApiKey();
		const model = (options.providerOptions?.model as string) ?? DEFAULT_MODEL;

		// Build the request body
		const input: Record<string, unknown> = {
			prompt: prompt.trim(),
			aspect_ratio: options.aspectRatio ?? "16:9",
			enhance_prompt: true,
		};

		if (options.duration) {
			const model = (options.providerOptions?.model as string) ?? DEFAULT_MODEL;
			// Veo uses "6s" format, Seedance/Kling use plain string "6"
			if (model.includes("veo")) {
				input.duration = `${options.duration}s`;
			} else {
				input.duration = `${options.duration}`;
			}
		}

		// Reference image for image-to-video
		if (options.referenceImage) {
			// fal.ai expects a URL or base64 data URI for image input
			const mimeType = options.referenceImageMimeType ?? "image/jpeg";
			const base64 = options.referenceImage.toString("base64");
			input.image_url = `data:${mimeType};base64,${base64}`;
		}

		// Step 1: Submit to queue
		const submitResult = await this.submitToQueue(prompt, apiKey, model, input);
		const requestId = submitResult.request_id;

		// Step 2: Poll until complete
		await this.pollStatus(requestId, apiKey, model);

		// Step 3: Get result
		const result = await this.getResult(requestId, apiKey, model);

		// Step 4: Download video
		if (!result.video?.url) {
			throw new VideoProviderError(
				"fal.ai response has no video URL.",
				"NO_VIDEO_IN_RESPONSE",
				this.name,
			);
		}

		const buffer = await this.downloadVideo(result.video.url);

		if (buffer.length < 1000) {
			throw new VideoProviderError(
				`Generated video is suspiciously small (${buffer.length} bytes).`,
				"INVALID_RESPONSE",
				this.name,
			);
		}

		return {
			buffer,
			mimeType: result.video.content_type ?? "video/mp4",
			model,
			prompt: prompt.trim(),
			metadata: {
				provider: this.name,
				requestId,
				videoUrl: result.video.url,
			},
		};
	}

	// -------------------------------------------------------------------------
	// Queue API
	// -------------------------------------------------------------------------

	async submitToQueue(
		prompt: string,
		apiKey: string,
		model: string,
		input: Record<string, unknown>,
	): Promise<FalQueueResponse> {
		const url = `${API_BASE}/${model}`;

		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Key ${apiKey}`,
					},
					body: JSON.stringify(input),
				});

				if (!response.ok) {
					const status = response.status;
					let errorMessage: string;
					try {
						const body = await response.json() as Record<string, unknown>;
						errorMessage = (body.detail as string) ?? (body.error as string) ?? JSON.stringify(body);
					} catch {
						errorMessage = `HTTP ${status}: ${response.statusText}`;
					}

					if (status === 429) {
						if (attempt < MAX_RETRIES) {
							await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
							continue;
						}
						throw new VideoProviderError(
							`Rate limited: ${errorMessage}`,
							"RATE_LIMITED",
							this.name,
							status,
						);
					}

					throw new VideoProviderError(
						`fal.ai submit error: ${errorMessage}`,
						"API_ERROR",
						this.name,
						status,
					);
				}

				const body = (await response.json()) as FalQueueResponse;
				if (!body.request_id) {
					throw new VideoProviderError(
						"fal.ai did not return a request_id.",
						"INVALID_RESPONSE",
						this.name,
					);
				}

				console.error(`[fal] Submitted to queue. Request ID: ${body.request_id}, response_url: ${body.response_url}, status_url: ${body.status_url}`);
				return body;
			} catch (error) {
				if (error instanceof VideoProviderError) throw error;
				lastError = error;
				if (attempt < MAX_RETRIES) {
					await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
					continue;
				}
			}
		}

		throw new VideoProviderError(
			`Network error submitting to fal.ai: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
			"NETWORK_ERROR",
			this.name,
		);
	}

	async pollStatus(
		requestId: string,
		apiKey: string,
		model: string,
	): Promise<void> {
		const queueModel = this.getQueueModelPath(model);
		const url = `${API_BASE}/${queueModel}/requests/${requestId}/status`;
		const startTime = Date.now();

		while (true) {
			const elapsed = Date.now() - startTime;
			if (elapsed >= TIMEOUT_MS) {
				throw new VideoProviderError(
					`Video generation timed out after ${Math.round(elapsed / 1000)}s. Request: ${requestId}`,
					"TIMEOUT",
					this.name,
				);
			}

			try {
				const response = await fetch(url, {
					headers: { Authorization: `Key ${apiKey}` },
				});

				if (!response.ok) {
					// Transient error — keep polling
					await sleep(POLL_INTERVAL_MS);
					continue;
				}

				const body = (await response.json()) as FalStatusResponse;

				if (body.status === "COMPLETED") {
					return;
				}

				if (body.status === "FAILED") {
					throw new VideoProviderError(
						`fal.ai generation failed: ${body.error ?? "Unknown error"}`,
						"OPERATION_FAILED",
						this.name,
					);
				}

				// IN_QUEUE or IN_PROGRESS — keep waiting
				await sleep(POLL_INTERVAL_MS);
			} catch (error) {
				if (error instanceof VideoProviderError) throw error;
				await sleep(POLL_INTERVAL_MS);
			}
		}
	}

	async getResult(
		requestId: string,
		apiKey: string,
		model: string,
	): Promise<FalResultResponse> {
		const queueModel = this.getQueueModelPath(model);
		const url = `${API_BASE}/${queueModel}/requests/${requestId}`;

		const response = await fetch(url, {
			headers: { Authorization: `Key ${apiKey}` },
		});

		if (!response.ok) {
			let errorMessage: string;
			try {
				const body = await response.json() as Record<string, unknown>;
				errorMessage = (body.detail as string) ?? JSON.stringify(body);
			} catch {
				errorMessage = `HTTP ${response.status}`;
			}
			throw new VideoProviderError(
				`Failed to fetch result: ${errorMessage}`,
				"API_ERROR",
				this.name,
				response.status,
			);
		}

		return (await response.json()) as FalResultResponse;
	}

	// -------------------------------------------------------------------------
	// Download
	// -------------------------------------------------------------------------

	async downloadVideo(videoUrl: string): Promise<Buffer> {
		const response = await fetch(videoUrl);
		if (!response.ok) {
			throw new VideoProviderError(
				`Failed to download video: HTTP ${response.status}`,
				"NETWORK_ERROR",
				this.name,
				response.status,
			);
		}

		const arrayBuffer = await response.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}
}
