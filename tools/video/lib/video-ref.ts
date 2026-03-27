/**
 * Video reference processing module.
 *
 * Provides utilities for extracting frames from video clips, analyzing them
 * with vision models, and preparing them as inputs for video generation.
 *
 * Prerequisites: `ffmpeg` and `ffprobe` must be available on PATH.
 *
 * Uses `Bun.spawn` for subprocess execution.
 */

import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { detectMimeType } from "./mime-detect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractFramesOptions {
	/** Number of frames to extract. Defaults to 5. */
	count?: number;
	/** Extract a frame every N seconds (overrides count). */
	intervalSeconds?: number;
	/** Output image format. Defaults to "png". */
	format?: "png" | "jpg";
	/** Directory for extracted frames. Defaults to /tmp/video-gen/frames. */
	outputDir?: string;
}

export interface ExtractedFrame {
	/** Path to the extracted frame image. */
	path: string;
	/** Timestamp in seconds where the frame was extracted. */
	timestamp: number;
	/** MIME type of the frame image. */
	mimeType: string;
}

export interface AnalyzeVideoOptions {
	/** Number of frames to extract for analysis. Defaults to 4. */
	frameCount?: number;
	/** Vision model to use via OpenRouter. Defaults to "google/gemini-2.5-flash-preview". */
	model?: string;
	/** OpenRouter API key override. */
	apiKey?: string;
}

export interface VideoAnalysis {
	/** Overall description of the video content. */
	description: string;
	/** Scene-by-scene breakdown (if detected). */
	scenes: Array<{ timestamp: number; description: string }>;
	/** Visual style description. */
	style: string;
	/** Subjects/characters identified. */
	subjects: string[];
	/** Overall mood/tone. */
	mood: string;
	/** Raw model response for debugging. */
	rawResponse?: string;
}

export interface PrepareReferenceOptions {
	/** Target video generation provider (to check capabilities). */
	targetProvider?: string;
	/** Number of frames to extract. Defaults to 4. */
	extractionCount?: number;
	/** Vision model for analysis. */
	analysisModel?: string;
}

export interface PreparedReference {
	/** Reference images extracted from the source video. */
	referenceImages: Array<{ path: string; timestamp: number; mimeType: string }>;
	/** Enriched prompt combining analysis + user changes. */
	enrichedPrompt: string;
	/** Original video analysis. */
	originalAnalysis: VideoAnalysis;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type VideoRefErrorCode =
	| "FFMPEG_NOT_FOUND"
	| "FFPROBE_FAILED"
	| "MISSING_INPUT"
	| "INVALID_ARGUMENTS"
	| "EXTRACTION_FAILED"
	| "ANALYSIS_FAILED"
	| "NETWORK_ERROR";

/** Structured error for video reference processing failures. */
export class VideoRefError extends Error {
	constructor(
		message: string,
		public readonly code: VideoRefErrorCode,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "VideoRefError";
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FRAME_COUNT = 5;
const DEFAULT_ANALYSIS_FRAME_COUNT = 4;
const DEFAULT_FRAME_FORMAT = "png";
const DEFAULT_OUTPUT_DIR = "/tmp/video-gen/frames";
const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash-preview";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check that ffmpeg is available on PATH. Throws VideoRefError if not. */
async function assertFfmpegAvailable(): Promise<void> {
	try {
		const proc = Bun.spawn(["which", "ffmpeg"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new VideoRefError(
				"ffmpeg is not installed or not on PATH. Install it with: brew install ffmpeg",
				"FFMPEG_NOT_FOUND",
			);
		}
	} catch (error) {
		if (error instanceof VideoRefError) throw error;
		throw new VideoRefError(
			`Failed to check for ffmpeg: ${error instanceof Error ? error.message : String(error)}`,
			"FFMPEG_NOT_FOUND",
			error,
		);
	}
}

/** Validate that a file exists on disk. Throws VideoRefError if not. */
async function assertFileExists(filePath: string, label: string): Promise<void> {
	const exists = await Bun.file(filePath).exists();
	if (!exists) {
		throw new VideoRefError(`${label} file not found: ${filePath}`, "MISSING_INPUT");
	}
}

/** Ensure a directory exists, creating it recursively if needed. */
async function ensureDir(dir: string): Promise<void> {
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		throw new VideoRefError(
			`Cannot create directory "${dir}": ${error instanceof Error ? error.message : String(error)}`,
			"EXTRACTION_FAILED",
			error,
		);
	}
}

/**
 * Probe a video's duration in seconds using ffprobe.
 * Returns the duration or throws a VideoRefError.
 */
async function probeVideoDuration(videoPath: string): Promise<number> {
	const proc = Bun.spawn(
		[
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			resolve(videoPath),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new VideoRefError(
			`ffprobe failed for "${videoPath}": ${stderr.slice(0, 500)}`,
			"FFPROBE_FAILED",
		);
	}

	const duration = Number.parseFloat(stdout.trim());
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new VideoRefError(
			`Could not determine duration of "${videoPath}" (got "${stdout.trim()}").`,
			"FFPROBE_FAILED",
		);
	}

	return duration;
}

/**
 * Extract a single frame at a given timestamp using ffmpeg.
 * Returns the absolute path to the extracted frame.
 */
async function extractSingleFrame(
	videoPath: string,
	timestamp: number,
	outputPath: string,
): Promise<void> {
	const args = [
		"-y",
		"-i",
		resolve(videoPath),
		"-ss",
		String(timestamp),
		"-vframes",
		"1",
		"-q:v",
		"2",
		resolve(outputPath),
	];

	const proc = Bun.spawn(["ffmpeg", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const [, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new VideoRefError(
			`Failed to extract frame at ${timestamp}s: ${stderr.slice(0, 500)}`,
			"EXTRACTION_FAILED",
		);
	}
}

// ---------------------------------------------------------------------------
// Public API: Frame extraction
// ---------------------------------------------------------------------------

/**
 * Extract key frames from a video file using ffmpeg.
 *
 * Frames are evenly spaced across the video duration (by count), or at
 * a fixed interval. Returns an array of extracted frame metadata including
 * file paths, timestamps, and detected MIME types.
 *
 * @param videoPath - Path to the input video file.
 * @param options - Extraction options (count, interval, format, output dir).
 * @returns Array of extracted frame metadata.
 *
 * @throws {VideoRefError} With code "MISSING_INPUT" if video doesn't exist.
 * @throws {VideoRefError} With code "INVALID_ARGUMENTS" for bad options.
 * @throws {VideoRefError} With code "FFMPEG_NOT_FOUND" if ffmpeg isn't available.
 * @throws {VideoRefError} With code "FFPROBE_FAILED" if duration can't be determined.
 * @throws {VideoRefError} With code "EXTRACTION_FAILED" if frame extraction fails.
 *
 * @example
 * ```ts
 * const frames = await extractFrames("/tmp/clip.mp4", { count: 4 });
 * // frames: [{ path: "/tmp/video-gen/frames/frame_0.png", timestamp: 0.5, mimeType: "image/png" }, ...]
 * ```
 */
export async function extractFrames(
	videoPath: string,
	options: ExtractFramesOptions = {},
): Promise<ExtractedFrame[]> {
	// --- Validate ---
	if (!videoPath || videoPath.trim() === "") {
		throw new VideoRefError("videoPath must be a non-empty string.", "INVALID_ARGUMENTS");
	}

	await assertFileExists(videoPath, "Video");

	const count = options.count ?? DEFAULT_FRAME_COUNT;
	const intervalSeconds = options.intervalSeconds;
	const format = options.format ?? DEFAULT_FRAME_FORMAT;
	const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;

	if (intervalSeconds === undefined && count <= 0) {
		throw new VideoRefError(`count must be a positive number (got ${count}).`, "INVALID_ARGUMENTS");
	}

	if (intervalSeconds !== undefined && intervalSeconds <= 0) {
		throw new VideoRefError(
			`intervalSeconds must be a positive number (got ${intervalSeconds}).`,
			"INVALID_ARGUMENTS",
		);
	}

	// --- Preflight ---
	await assertFfmpegAvailable();
	await ensureDir(outputDir);

	// --- Get video duration ---
	const duration = await probeVideoDuration(videoPath);

	// --- Calculate timestamps ---
	let timestamps: number[];

	if (intervalSeconds !== undefined) {
		// Interval mode: extract at every N seconds
		timestamps = [];
		for (let t = 0; t < duration; t += intervalSeconds) {
			timestamps.push(t);
		}
		// Ensure we don't have zero frames
		if (timestamps.length === 0) {
			timestamps.push(0);
		}
	} else {
		// Count mode: evenly space frames across the duration
		timestamps = [];
		if (count === 1) {
			timestamps.push(duration / 2);
		} else {
			// Distribute frames evenly, avoiding the very start and end
			const step = duration / (count + 1);
			for (let i = 1; i <= count; i++) {
				timestamps.push(step * i);
			}
		}
	}

	// --- Extract frames ---
	const sessionId = crypto.randomUUID().slice(0, 8);
	const frames: ExtractedFrame[] = [];

	for (let i = 0; i < timestamps.length; i++) {
		const timestamp = timestamps[i];
		const framePath = join(outputDir, `frame_${sessionId}_${i}.${format}`);

		await extractSingleFrame(videoPath, timestamp, framePath);

		// Detect actual MIME type from the extracted frame
		const frameBuffer = Buffer.from(await Bun.file(framePath).arrayBuffer());
		const detected = detectMimeType(frameBuffer);

		frames.push({
			path: resolve(framePath),
			timestamp,
			mimeType: detected.mimeType,
		});
	}

	return frames;
}

// ---------------------------------------------------------------------------
// Public API: Video analysis with vision model
// ---------------------------------------------------------------------------

/**
 * Analyze a video's content using a vision model.
 *
 * Extracts frames from the video and sends them to a vision model (via
 * OpenRouter) along with a prompt. Returns a structured analysis of the
 * video content including description, scenes, style, subjects, and mood.
 *
 * @param videoPath - Path to the input video file.
 * @param prompt - Describe what you want to understand about the video.
 * @param options - Analysis options (frame count, model, API key).
 * @returns Structured video analysis.
 *
 * @throws {VideoRefError} With code "MISSING_INPUT" if video doesn't exist.
 * @throws {VideoRefError} With code "ANALYSIS_FAILED" if vision model fails.
 * @throws {VideoRefError} With code "NETWORK_ERROR" on API connectivity issues.
 *
 * @example
 * ```ts
 * const analysis = await analyzeVideoWithVision(
 *   "/tmp/clip.mp4",
 *   "Describe the scene, characters, and visual style",
 * );
 * // analysis.description, analysis.scenes, analysis.style, etc.
 * ```
 */
export async function analyzeVideoWithVision(
	videoPath: string,
	prompt: string,
	options: AnalyzeVideoOptions = {},
): Promise<VideoAnalysis> {
	// --- Validate ---
	if (!videoPath || videoPath.trim() === "") {
		throw new VideoRefError("videoPath must be a non-empty string.", "INVALID_ARGUMENTS");
	}

	await assertFileExists(videoPath, "Video");

	const frameCount = options.frameCount ?? DEFAULT_ANALYSIS_FRAME_COUNT;
	const model = options.model ?? DEFAULT_VISION_MODEL;
	const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;

	if (!apiKey) {
		throw new VideoRefError(
			"OPENROUTER_API_KEY environment variable is not set and no apiKey was provided.",
			"ANALYSIS_FAILED",
		);
	}

	// --- Extract frames ---
	const frames = await extractFrames(videoPath, { count: frameCount });

	// --- Build multimodal message ---
	const imageContent: Array<Record<string, unknown>> = [];

	for (const frame of frames) {
		const fileBuffer = await readFile(frame.path);
		const base64 = fileBuffer.toString("base64");
		const dataUri = `data:${frame.mimeType};base64,${base64}`;

		imageContent.push({
			type: "image_url",
			image_url: { url: dataUri },
		});
	}

	// Add the text prompt
	imageContent.push({
		type: "text",
		text: prompt,
	});

	const systemPrompt = `You are a video analysis expert. Analyze the provided video frames and return a JSON object with this exact structure:
{
  "description": "Overall description of the video content",
  "scenes": [{ "timestamp": 0, "description": "Description of what happens at this point" }],
  "style": "Description of the visual style (cinematography, color palette, lighting, etc.)",
  "subjects": ["List of subjects, characters, or objects identified"],
  "mood": "Overall mood or tone of the video"
}

Respond with ONLY the JSON object, no markdown code blocks, no extra text.`;

	const requestBody = {
		model,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: imageContent },
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
			throw new VideoRefError(
				`OpenRouter API returned ${response.status}: ${errorBody.slice(0, 500)}`,
				"ANALYSIS_FAILED",
			);
		}

		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};

		responseText = data.choices?.[0]?.message?.content ?? "";
		if (!responseText) {
			throw new VideoRefError("Vision model returned an empty response.", "ANALYSIS_FAILED");
		}
	} catch (error) {
		if (error instanceof VideoRefError) throw error;

		// Check for network errors specifically
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (
			errorMessage.includes("fetch") ||
			errorMessage.includes("ECONNREFUSED") ||
			errorMessage.includes("ENOTFOUND") ||
			errorMessage.includes("network")
		) {
			throw new VideoRefError(
				`Network error calling OpenRouter: ${errorMessage}`,
				"NETWORK_ERROR",
				error,
			);
		}

		throw new VideoRefError(`Failed to analyze video: ${errorMessage}`, "ANALYSIS_FAILED", error);
	}

	// --- Parse response ---
	return parseVideoAnalysis(responseText);
}

/**
 * Parse a vision model response into a VideoAnalysis object.
 * Handles cases where the model returns non-JSON gracefully.
 */
function parseVideoAnalysis(responseText: string): VideoAnalysis {
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
			scenes: Array.isArray(parsed.scenes)
				? parsed.scenes.map((s: Record<string, unknown>) => ({
						timestamp: typeof s.timestamp === "number" ? s.timestamp : 0,
						description: typeof s.description === "string" ? s.description : "",
					}))
				: [],
			style: typeof parsed.style === "string" ? parsed.style : "",
			subjects: Array.isArray(parsed.subjects)
				? parsed.subjects.filter((s: unknown): s is string => typeof s === "string")
				: [],
			mood: typeof parsed.mood === "string" ? parsed.mood : "",
			rawResponse: responseText,
		};
	} catch {
		// If JSON parsing fails, create a best-effort analysis from the raw text
		return {
			description: responseText.slice(0, 500),
			scenes: [],
			style: "",
			subjects: [],
			mood: "",
			rawResponse: responseText,
		};
	}
}

// ---------------------------------------------------------------------------
// Public API: Prepare video reference
// ---------------------------------------------------------------------------

/**
 * Full pipeline for preparing a video clip as a generation input.
 *
 * Extracts frames from the source video, analyzes them with a vision model,
 * and builds an enriched prompt that combines the original video description
 * with the user's requested changes.
 *
 * @param videoPath - Path to the source video file.
 * @param changes - Description of what to change (e.g. "make the sky purple and add rain").
 * @param options - Preparation options (target provider, extraction count, analysis model).
 * @returns Reference images, enriched prompt, and original analysis.
 *
 * @throws {VideoRefError} With code "MISSING_INPUT" if video doesn't exist.
 * @throws {VideoRefError} With code "ANALYSIS_FAILED" if vision analysis fails.
 *
 * @example
 * ```ts
 * const ref = await prepareVideoReference(
 *   "/tmp/original-clip.mp4",
 *   "Change the time of day to sunset and add dramatic clouds",
 * );
 * // Use ref.referenceImages for image-to-video, ref.enrichedPrompt for the generation prompt
 * ```
 */
export async function prepareVideoReference(
	videoPath: string,
	changes: string,
	options: PrepareReferenceOptions = {},
): Promise<PreparedReference> {
	// --- Validate ---
	if (!videoPath || videoPath.trim() === "") {
		throw new VideoRefError("videoPath must be a non-empty string.", "INVALID_ARGUMENTS");
	}

	await assertFileExists(videoPath, "Video");

	const extractionCount = options.extractionCount ?? DEFAULT_ANALYSIS_FRAME_COUNT;
	const analysisModel = options.analysisModel;

	// --- Extract frames ---
	const frames = await extractFrames(videoPath, { count: extractionCount });

	// --- Analyze original video ---
	const analysisPrompt = `Analyze these video frames in detail. I want to modify this video to: ${changes}\nProvide a thorough analysis of the original video content so I can generate a modified version.`;

	const analysis = await analyzeVideoWithVision(videoPath, analysisPrompt, {
		frameCount: extractionCount,
		model: analysisModel,
	});

	// --- Build enriched prompt ---
	const enrichedPrompt = buildEnrichedPrompt(analysis, changes);

	// --- Build reference images array ---
	const referenceImages = frames.map((f) => ({
		path: f.path,
		timestamp: f.timestamp,
		mimeType: f.mimeType,
	}));

	return {
		referenceImages,
		enrichedPrompt,
		originalAnalysis: analysis,
	};
}

/**
 * Build an enriched prompt combining the original analysis with requested changes.
 */
function buildEnrichedPrompt(analysis: VideoAnalysis, changes: string): string {
	const parts: string[] = [];

	parts.push("Create a video based on the following reference:");
	parts.push("");

	if (analysis.description) {
		parts.push(`Original video: ${analysis.description}`);
	}

	if (analysis.style) {
		parts.push(`Visual style: ${analysis.style}`);
	}

	if (analysis.subjects.length > 0) {
		parts.push(`Subjects: ${analysis.subjects.join(", ")}`);
	}

	if (analysis.mood) {
		parts.push(`Mood: ${analysis.mood}`);
	}

	parts.push("");
	parts.push(`Requested changes: ${changes}`);

	if (analysis.scenes.length > 0) {
		parts.push("");
		parts.push("Scene breakdown:");
		for (const scene of analysis.scenes) {
			parts.push(`  - At ${scene.timestamp}s: ${scene.description}`);
		}
	}

	return parts.join("\n");
}
