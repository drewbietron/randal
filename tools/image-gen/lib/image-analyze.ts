/**
 * Image analysis module — sends images to a multimodal vision model for structured analysis.
 *
 * Follows the same pattern as video-ref.ts's analyzeVideoWithVision(), but for single images.
 * Uses OpenRouter's chat completions endpoint with multimodal messages.
 *
 * Environment: OPENROUTER_API_KEY
 */

import { detectMimeType } from "./mime-detect";
import type { AnalyzeImageOptions, AnalyzeImageResult } from "./providers/types";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type ImageAnalysisErrorCode =
	| "MISSING_API_KEY"
	| "MISSING_INPUT"
	| "INVALID_RESPONSE"
	| "NETWORK_ERROR"
	| "API_ERROR";

/** Structured error for image analysis failures. */
export class ImageAnalysisError extends Error {
	constructor(
		message: string,
		public readonly code: ImageAnalysisErrorCode,
		public readonly statusCode?: number,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "ImageAnalysisError";
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash-preview";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_SYSTEM_PROMPT = `You are an image analysis expert. Analyze the provided image and return a JSON object with this structure:
{
  "description": "Detailed description of the image",
  "objects": ["list", "of", "objects", "detected"],
  "text": ["any", "text", "found", "in", "image"],
  "colors": ["dominant", "colors"],
  "style": "Visual style description (photography, illustration, etc.)",
  "mood": "Overall mood or tone"
}
Respond with ONLY the JSON, no markdown code blocks.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze an image using a multimodal vision model via OpenRouter.
 *
 * Accepts either a file path (string) or raw image data (Buffer). Sends the
 * image to the vision model along with the user's prompt and returns a
 * structured analysis result.
 *
 * @param input - Path to an image file on disk, or a Buffer of image data.
 * @param prompt - The user's question or instruction about the image.
 * @param options - Optional overrides for model, system prompt, etc.
 * @returns Structured analysis of the image.
 *
 * @throws {ImageAnalysisError} With code "MISSING_INPUT" if input is empty or file not found.
 * @throws {ImageAnalysisError} With code "MISSING_API_KEY" if OPENROUTER_API_KEY is not set.
 * @throws {ImageAnalysisError} With code "NETWORK_ERROR" on API connectivity issues.
 * @throws {ImageAnalysisError} With code "API_ERROR" if the API returns an error status.
 * @throws {ImageAnalysisError} With code "INVALID_RESPONSE" if the response cannot be parsed.
 *
 * @example
 * ```ts
 * const result = await analyzeImage("/tmp/photo.jpg", "Describe what you see");
 * // result.description, result.objects, result.colors, etc.
 * ```
 */
export async function analyzeImage(
	input: string | Buffer,
	prompt: string,
	options?: AnalyzeImageOptions,
): Promise<AnalyzeImageResult> {
	// --- Validate input ---
	if (!input || (typeof input === "string" && input.trim() === "")) {
		throw new ImageAnalysisError("Input must be a non-empty file path or Buffer.", "MISSING_INPUT");
	}

	if (Buffer.isBuffer(input) && input.length === 0) {
		throw new ImageAnalysisError("Input buffer is empty.", "MISSING_INPUT");
	}

	// --- Read image data ---
	let imageBuffer: Buffer;

	if (typeof input === "string") {
		// File path — read from disk
		try {
			const file = Bun.file(input);
			if (!(await file.exists())) {
				throw new ImageAnalysisError(`Image file not found: ${input}`, "MISSING_INPUT");
			}
			const arrayBuf = await file.arrayBuffer();
			imageBuffer = Buffer.from(arrayBuf);
		} catch (error) {
			if (error instanceof ImageAnalysisError) throw error;
			throw new ImageAnalysisError(
				`Failed to read image file "${input}": ${error instanceof Error ? error.message : String(error)}`,
				"MISSING_INPUT",
				undefined,
				error,
			);
		}
	} else {
		imageBuffer = input;
	}

	// --- Detect MIME type ---
	const detected = detectMimeType(imageBuffer);
	const mimeType = detected.mimeType;

	// --- Resolve options ---
	const model = options?.model ?? DEFAULT_VISION_MODEL;
	const systemPrompt = options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	const apiKey = process.env.OPENROUTER_API_KEY;

	if (!apiKey) {
		throw new ImageAnalysisError(
			"OPENROUTER_API_KEY environment variable is not set.",
			"MISSING_API_KEY",
		);
	}

	// --- Build data URI ---
	const base64 = imageBuffer.toString("base64");
	const dataUri = `data:${mimeType};base64,${base64}`;

	// --- Build multimodal message ---
	const requestBody = {
		model,
		messages: [
			{ role: "system", content: systemPrompt },
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: dataUri },
					},
					{
						type: "text",
						text: prompt,
					},
				],
			},
		],
		temperature: 0.3,
		max_tokens: 2000,
	};

	// --- Call OpenRouter vision API ---
	let responseText: string;
	try {
		const response = await fetch(OPENROUTER_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new ImageAnalysisError(
				`OpenRouter API returned ${response.status}: ${errorBody.slice(0, 500)}`,
				"API_ERROR",
				response.status,
			);
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};

		responseText = data.choices?.[0]?.message?.content ?? "";
		if (!responseText) {
			throw new ImageAnalysisError("Vision model returned an empty response.", "INVALID_RESPONSE");
		}
	} catch (error) {
		if (error instanceof ImageAnalysisError) throw error;

		// Check for network errors specifically
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (
			errorMessage.includes("fetch") ||
			errorMessage.includes("ECONNREFUSED") ||
			errorMessage.includes("ENOTFOUND") ||
			errorMessage.includes("network")
		) {
			throw new ImageAnalysisError(
				`Network error calling OpenRouter: ${errorMessage}`,
				"NETWORK_ERROR",
				undefined,
				error,
			);
		}

		throw new ImageAnalysisError(
			`Failed to analyze image: ${errorMessage}`,
			"API_ERROR",
			undefined,
			error,
		);
	}

	// --- Parse response ---
	return parseImageAnalysis(responseText, model);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a vision model response into an AnalyzeImageResult.
 * Handles cases where the model returns non-JSON gracefully.
 */
function parseImageAnalysis(responseText: string, model: string): AnalyzeImageResult {
	// Try to extract JSON from the response (model may wrap it in markdown code blocks)
	let jsonText = responseText.trim();

	// Strip markdown code fences if present
	const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		jsonText = codeBlockMatch[1].trim();
	}

	try {
		const parsed = JSON.parse(jsonText);

		return {
			description: typeof parsed.description === "string" ? parsed.description : "",
			objects: Array.isArray(parsed.objects)
				? parsed.objects.filter((o: unknown): o is string => typeof o === "string")
				: [],
			text: Array.isArray(parsed.text)
				? parsed.text.filter((t: unknown): t is string => typeof t === "string")
				: [],
			colors: Array.isArray(parsed.colors)
				? parsed.colors.filter((c: unknown): c is string => typeof c === "string")
				: [],
			style: typeof parsed.style === "string" ? parsed.style : "",
			mood: typeof parsed.mood === "string" ? parsed.mood : "",
			model,
			rawResponse: responseText,
		};
	} catch {
		// If JSON parsing fails, create a best-effort result from the raw text
		return {
			description: responseText.slice(0, 500),
			objects: [],
			text: [],
			colors: [],
			style: "",
			mood: "",
			model,
			rawResponse: responseText,
		};
	}
}
