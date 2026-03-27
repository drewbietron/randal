/**
 * Audio generation module — public API.
 *
 * Thin wrapper around the audio provider registry, plus ffmpeg-based
 * audio mixing and video muxing utilities.
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { getAudioProvider } from "./providers/audio-registry";
import type {
	GenerateMusicOptions,
	GenerateMusicResult,
	GenerateSpeechOptions,
	GenerateSpeechResult,
} from "./providers/types";

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { getAudioProvider, listAudioProviders } from "./providers/audio-registry";
export type {
	AudioProvider,
	GenerateMusicOptions,
	GenerateMusicResult,
	GenerateSpeechOptions,
	GenerateSpeechResult,
} from "./providers/types";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type AudioGenErrorCode =
	| "FFMPEG_NOT_FOUND"
	| "MISSING_INPUT"
	| "INVALID_ARGUMENTS"
	| "FFMPEG_FAILED"
	| "PROVIDER_ERROR"
	| "MUSIC_NOT_SUPPORTED";

/** Structured error for audio generation / mixing failures. */
export class AudioGenError extends Error {
	constructor(
		message: string,
		public readonly code: AudioGenErrorCode,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "AudioGenError";
	}
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AudioGenOptions extends GenerateSpeechOptions {
	/** Provider name override. */
	provider?: string;
}

export interface MixTrack {
	/** Path to an audio file. */
	path: string;
	/** Volume multiplier (0.0 to 1.0+). Defaults to 1.0. */
	volume?: number;
	/** Delay before this track starts, in seconds. Defaults to 0. */
	delay?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers (ffmpeg)
// ---------------------------------------------------------------------------

/** Check that ffmpeg is available on PATH. Throws AudioGenError if not. */
async function assertFfmpegAvailable(): Promise<void> {
	try {
		const proc = Bun.spawn(["which", "ffmpeg"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new AudioGenError(
				"ffmpeg is not installed or not on PATH. Install it with: brew install ffmpeg",
				"FFMPEG_NOT_FOUND",
			);
		}
	} catch (error) {
		if (error instanceof AudioGenError) throw error;
		throw new AudioGenError(
			`Failed to check for ffmpeg: ${error instanceof Error ? error.message : String(error)}`,
			"FFMPEG_NOT_FOUND",
			error,
		);
	}
}

/** Run an ffmpeg command. Throws AudioGenError on failure. */
async function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn(["ffmpeg", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new AudioGenError(
			`ffmpeg exited with code ${exitCode}.\nCommand: ffmpeg ${args.join(" ")}\nStderr:\n${stderr.slice(0, 2000)}`,
			"FFMPEG_FAILED",
		);
	}

	return { stdout, stderr };
}

/** Validate that a file exists on disk. Throws AudioGenError if not. */
async function assertFileExists(filePath: string, label: string): Promise<void> {
	const exists = await Bun.file(filePath).exists();
	if (!exists) {
		throw new AudioGenError(`${label} file not found: ${filePath}`, "MISSING_INPUT");
	}
}

/** Ensure the output directory exists. */
async function ensureOutputDir(outputPath: string): Promise<void> {
	const dir = dirname(resolve(outputPath));
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		throw new AudioGenError(
			`Cannot create output directory "${dir}": ${error instanceof Error ? error.message : String(error)}`,
			"FFMPEG_FAILED",
			error,
		);
	}
}

// ---------------------------------------------------------------------------
// Public API: Speech generation
// ---------------------------------------------------------------------------

/**
 * Generate speech audio from text.
 *
 * Delegates to the audio provider registry. If `options.provider` is specified,
 * uses that specific provider; otherwise falls back to the first configured provider.
 *
 * @param text - The text to convert to speech.
 * @param options - Speech generation options (voice, model, speed, format, provider).
 * @returns The generated audio data.
 *
 * @throws {AudioGenError} With code "PROVIDER_ERROR" on provider failures.
 */
export async function generateSpeech(
	text: string,
	options?: AudioGenOptions,
): Promise<GenerateSpeechResult> {
	try {
		const provider = getAudioProvider(options?.provider);
		return await provider.generateSpeech(text, options);
	} catch (error) {
		if (error instanceof AudioGenError) throw error;
		throw new AudioGenError(
			`Speech generation failed: ${error instanceof Error ? error.message : String(error)}`,
			"PROVIDER_ERROR",
			error,
		);
	}
}

// ---------------------------------------------------------------------------
// Public API: Music generation
// ---------------------------------------------------------------------------

/**
 * Generate music from a text prompt.
 *
 * Delegates to the audio provider registry. Throws if the selected provider
 * does not support music generation.
 *
 * @param prompt - Text description of the music to generate.
 * @param options - Music generation options (duration, genre, mood, format, provider).
 * @returns The generated music data.
 *
 * @throws {AudioGenError} With code "MUSIC_NOT_SUPPORTED" if the provider doesn't support music.
 * @throws {AudioGenError} With code "PROVIDER_ERROR" on provider failures.
 */
export async function generateMusic(
	prompt: string,
	options?: GenerateMusicOptions & { provider?: string },
): Promise<GenerateMusicResult> {
	try {
		const provider = getAudioProvider(options?.provider);
		if (!provider.generateMusic) {
			throw new AudioGenError(
				`Provider "${provider.name}" does not support music generation. Try a different provider or use generateSpeech instead.`,
				"MUSIC_NOT_SUPPORTED",
			);
		}
		return await provider.generateMusic(prompt, options);
	} catch (error) {
		if (error instanceof AudioGenError) throw error;
		throw new AudioGenError(
			`Music generation failed: ${error instanceof Error ? error.message : String(error)}`,
			"PROVIDER_ERROR",
			error,
		);
	}
}

// ---------------------------------------------------------------------------
// Public API: Audio mixing
// ---------------------------------------------------------------------------

/**
 * Mix multiple audio tracks into a single output file using ffmpeg.
 *
 * Supports volume adjustment and per-track delay. Uses the `amix` filter
 * for combining tracks.
 *
 * @param tracks - One or more audio tracks to mix.
 * @param outputPath - Path for the output audio file.
 * @returns The absolute path to the output file.
 *
 * @throws {AudioGenError} With code "INVALID_ARGUMENTS" if tracks array is empty.
 * @throws {AudioGenError} With code "MISSING_INPUT" if a track file doesn't exist.
 * @throws {AudioGenError} With code "FFMPEG_NOT_FOUND" if ffmpeg isn't available.
 * @throws {AudioGenError} With code "FFMPEG_FAILED" if ffmpeg fails.
 *
 * @example
 * ```ts
 * const output = await mixAudioTracks(
 *   [
 *     { path: "/tmp/narration.mp3", volume: 1.0 },
 *     { path: "/tmp/music.mp3", volume: 0.3, delay: 2.0 },
 *   ],
 *   "/tmp/mixed.mp3",
 * );
 * ```
 */
export async function mixAudioTracks(tracks: MixTrack[], outputPath: string): Promise<string> {
	// --- Validate ---
	if (!Array.isArray(tracks) || tracks.length === 0) {
		throw new AudioGenError(
			`mixAudioTracks requires at least 1 track (got ${Array.isArray(tracks) ? tracks.length : "non-array"}).`,
			"INVALID_ARGUMENTS",
		);
	}

	if (!outputPath || outputPath.trim() === "") {
		throw new AudioGenError("outputPath must be a non-empty string.", "INVALID_ARGUMENTS");
	}

	// Validate all track files exist
	for (const track of tracks) {
		await assertFileExists(track.path, "Audio track");
	}

	await assertFfmpegAvailable();
	await ensureOutputDir(outputPath);

	const absOutput = resolve(outputPath);

	// Single track — just copy/re-encode with volume adjustment
	if (tracks.length === 1) {
		const t = tracks[0];
		const vol = t.volume ?? 1.0;
		const delay = t.delay ?? 0;

		const args = ["-y", "-i", resolve(t.path)];

		if (vol !== 1.0 || delay > 0) {
			const delayMs = Math.round(delay * 1000);
			args.push(
				"-filter_complex",
				`[0]volume=${vol},adelay=${delayMs}|${delayMs}[a0]`,
				"-map",
				"[a0]",
			);
		}

		args.push(absOutput);
		await runFfmpeg(args);
		return absOutput;
	}

	// Multiple tracks — use amix filter
	const args: string[] = ["-y"];

	// Add all inputs
	for (const track of tracks) {
		args.push("-i", resolve(track.path));
	}

	// Build filter_complex for volume/delay + amix
	const filterParts: string[] = [];
	const mixInputs: string[] = [];

	for (let i = 0; i < tracks.length; i++) {
		const vol = tracks[i].volume ?? 1.0;
		const delay = tracks[i].delay ?? 0;
		const delayMs = Math.round(delay * 1000);
		const label = `a${i}`;

		filterParts.push(`[${i}]volume=${vol},adelay=${delayMs}|${delayMs}[${label}]`);
		mixInputs.push(`[${label}]`);
	}

	filterParts.push(`${mixInputs.join("")}amix=inputs=${tracks.length}:duration=longest`);

	args.push("-filter_complex", filterParts.join(";"));
	args.push(absOutput);

	await runFfmpeg(args);
	return absOutput;
}

// ---------------------------------------------------------------------------
// Public API: Attach audio to video
// ---------------------------------------------------------------------------

/**
 * Attach an audio track to a video file using ffmpeg.
 *
 * By default, adds the audio as an additional track. Set `options.replace` to
 * true to replace any existing audio in the video.
 *
 * @param videoPath - Path to the input video file.
 * @param audioPath - Path to the input audio file.
 * @param outputPath - Path for the output video file.
 * @param options - Options: `replace` (default false) to replace existing audio.
 * @returns The absolute path to the output file.
 *
 * @throws {AudioGenError} With code "MISSING_INPUT" if video or audio doesn't exist.
 * @throws {AudioGenError} With code "FFMPEG_NOT_FOUND" if ffmpeg isn't available.
 * @throws {AudioGenError} With code "FFMPEG_FAILED" if ffmpeg fails.
 *
 * @example
 * ```ts
 * const output = await attachAudioToVideo(
 *   "/tmp/video.mp4",
 *   "/tmp/narration.mp3",
 *   "/tmp/final.mp4",
 *   { replace: true },
 * );
 * ```
 */
export async function attachAudioToVideo(
	videoPath: string,
	audioPath: string,
	outputPath: string,
	options?: { replace?: boolean },
): Promise<string> {
	// --- Validate ---
	await assertFileExists(videoPath, "Video");
	await assertFileExists(audioPath, "Audio");

	await assertFfmpegAvailable();
	await ensureOutputDir(outputPath);

	const absOutput = resolve(outputPath);
	const replace = options?.replace ?? false;

	const args: string[] = [
		"-y",
		"-i",
		resolve(videoPath),
		"-i",
		resolve(audioPath),
		"-c:v",
		"copy",
		"-c:a",
		"aac",
	];

	if (replace) {
		// Replace: take video from input 0, audio from input 1
		args.push("-map", "0:v", "-map", "1:a");
	} else {
		// Add: take all streams from input 0, add audio from input 1
		args.push("-map", "0", "-map", "1:a");
	}

	// Use shortest so the output matches the shorter of video/audio
	args.push("-shortest");
	args.push(absOutput);

	await runFfmpeg(args);
	return absOutput;
}
