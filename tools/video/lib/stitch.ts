/**
 * ffmpeg stitch module — concatenates video clips into a single output file.
 *
 * Two modes:
 * - **Simple concat** (transition: "none"): Uses ffmpeg concat demuxer.
 *   Writes a temp file list, then runs `ffmpeg -f concat -safe 0 -i filelist.txt -c copy output.mp4`.
 *   Fast, lossless — requires all clips to have the same codec/resolution.
 *
 * - **Crossfade** (transition: "crossfade"): Chains N-1 xfade filters.
 *   Re-encodes the video — slower but produces smooth transitions.
 *
 * Prerequisites: `ffmpeg` must be available on PATH.
 *
 * Uses `Bun.$` shell for subprocess execution.
 */

import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StitchOptions {
	/** Transition mode. Defaults to "none" (simple concat). */
	transition?: "crossfade" | "none";
	/** Duration of each crossfade transition in seconds. Defaults to 1. Only used when transition is "crossfade". */
	transitionDuration?: number;
	/** Output video codec. Defaults to "libx264" for crossfade, "copy" for concat. */
	codec?: string;
	/** Output frames per second. Only used for crossfade (forces re-encode). */
	fps?: number;
}

export type StitchErrorCode =
	| "FFMPEG_NOT_FOUND"
	| "MISSING_INPUT"
	| "INVALID_ARGUMENTS"
	| "FFMPEG_FAILED"
	| "OUTPUT_DIR_ERROR"
	| "CLEANUP_FAILED";

/** Structured error for stitch failures. */
export class StitchError extends Error {
	constructor(
		message: string,
		public readonly code: StitchErrorCode,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "StitchError";
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TRANSITION_DURATION = 1;
const DEFAULT_CROSSFADE_CODEC = "libx264";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check that ffmpeg is available on PATH. Throws StitchError if not. */
async function assertFfmpegAvailable(): Promise<void> {
	try {
		const proc = Bun.spawn(["which", "ffmpeg"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new StitchError(
				"ffmpeg is not installed or not on PATH. Install it with: brew install ffmpeg",
				"FFMPEG_NOT_FOUND",
			);
		}
	} catch (error) {
		if (error instanceof StitchError) throw error;
		throw new StitchError(
			`Failed to check for ffmpeg: ${error instanceof Error ? error.message : String(error)}`,
			"FFMPEG_NOT_FOUND",
			error,
		);
	}
}

/** Validate that all input clip paths exist on disk. */
async function validateClipPaths(clipPaths: string[]): Promise<void> {
	const missing: string[] = [];
	for (const clipPath of clipPaths) {
		const exists = await Bun.file(clipPath).exists();
		if (!exists) {
			missing.push(clipPath);
		}
	}
	if (missing.length > 0) {
		throw new StitchError(
			`Missing input file(s):\n${missing.map((p) => `  - ${p}`).join("\n")}`,
			"MISSING_INPUT",
		);
	}
}

/** Ensure the output directory exists. */
async function ensureOutputDir(outputPath: string): Promise<void> {
	const dir = dirname(resolve(outputPath));
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		throw new StitchError(
			`Cannot create output directory "${dir}": ${error instanceof Error ? error.message : String(error)}`,
			"OUTPUT_DIR_ERROR",
			error,
		);
	}
}

/** Write a concat demuxer file list for ffmpeg. Returns the temp file path. */
async function writeConcatFileList(clipPaths: string[]): Promise<string> {
	const tempPath = join(tmpdir(), `ffmpeg-concat-${crypto.randomUUID()}.txt`);
	const content = clipPaths.map((p) => `file '${resolve(p)}'`).join("\n");
	await Bun.write(tempPath, content);
	return tempPath;
}

/** Attempt to remove a file. Logs but does not throw on failure. */
async function cleanupFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch {
		// Best-effort cleanup — don't throw
	}
}

/** Run an ffmpeg command and return stdout/stderr. Throws StitchError on failure. */
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
		throw new StitchError(
			`ffmpeg exited with code ${exitCode}.\nCommand: ffmpeg ${args.join(" ")}\nStderr:\n${stderr.slice(0, 2000)}`,
			"FFMPEG_FAILED",
		);
	}

	return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Concat (no transitions)
// ---------------------------------------------------------------------------

async function concatSimple(
	clipPaths: string[],
	outputPath: string,
	codec: string,
): Promise<string> {
	const fileListPath = await writeConcatFileList(clipPaths);
	try {
		const args = [
			"-y",
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			fileListPath,
			"-c",
			codec,
			resolve(outputPath),
		];
		await runFfmpeg(args);
		return resolve(outputPath);
	} finally {
		await cleanupFile(fileListPath);
	}
}

// ---------------------------------------------------------------------------
// Crossfade transitions
// ---------------------------------------------------------------------------

/**
 * Build the ffmpeg filter_complex string for chaining N-1 xfade filters.
 *
 * For N clips we need N-1 xfade stages:
 *   [0][1]xfade=transition=fade:duration=D:offset=O1[v01];
 *   [v01][2]xfade=transition=fade:duration=D:offset=O2[v012];
 *   ...
 *
 * The offset for each xfade is the accumulated duration minus the accumulated
 * transition overlap up to that point.
 */
function buildXfadeFilterComplex(
	clipCount: number,
	transitionDuration: number,
	clipDurations: number[],
): string {
	if (clipCount < 2) return "";

	const filters: string[] = [];
	let accumulatedDuration = clipDurations[0];

	for (let i = 1; i < clipCount; i++) {
		const offset = accumulatedDuration - transitionDuration;
		const inputLabel = i === 1 ? "[0][1]" : `[v${i - 1}][${i}]`;
		const outputLabel = i === clipCount - 1 ? "[vout]" : `[v${i}]`;

		filters.push(
			`${inputLabel}xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(3)}${outputLabel}`,
		);

		// Next accumulated duration: add this clip's duration minus the overlap
		accumulatedDuration += clipDurations[i] - transitionDuration;
	}

	return filters.join(";");
}

/**
 * Probe a clip's duration in seconds using ffprobe.
 * Returns the duration or throws a StitchError.
 */
async function probeDuration(clipPath: string): Promise<number> {
	const proc = Bun.spawn(
		[
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			resolve(clipPath),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new StitchError(
			`ffprobe failed for "${clipPath}": ${stderr.slice(0, 500)}`,
			"FFMPEG_FAILED",
		);
	}

	const duration = Number.parseFloat(stdout.trim());
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new StitchError(
			`Could not determine duration of "${clipPath}" (got "${stdout.trim()}").`,
			"FFMPEG_FAILED",
		);
	}

	return duration;
}

async function concatCrossfade(
	clipPaths: string[],
	outputPath: string,
	transitionDuration: number,
	codec: string,
	fps?: number,
): Promise<string> {
	// Probe durations for all clips
	const durations = await Promise.all(clipPaths.map(probeDuration));

	// Validate that every clip is longer than the transition
	for (let i = 0; i < durations.length; i++) {
		if (durations[i] <= transitionDuration) {
			throw new StitchError(
				`Clip "${clipPaths[i]}" duration (${durations[i].toFixed(2)}s) is not longer than transition duration (${transitionDuration}s).`,
				"INVALID_ARGUMENTS",
			);
		}
	}

	const filterComplex = buildXfadeFilterComplex(clipPaths.length, transitionDuration, durations);

	const args: string[] = ["-y"];

	// Add all inputs
	for (const clipPath of clipPaths) {
		args.push("-i", resolve(clipPath));
	}

	// Add filter complex
	args.push("-filter_complex", filterComplex);
	args.push("-map", "[vout]");

	// Codec and quality
	args.push("-c:v", codec);
	if (codec === "libx264") {
		args.push("-preset", "medium", "-crf", "23");
	}

	// FPS
	if (fps) {
		args.push("-r", String(fps));
	}

	// No audio in the xfade pipeline (xfade is video-only)
	args.push("-an");

	args.push(resolve(outputPath));

	await runFfmpeg(args);
	return resolve(outputPath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stitch (concatenate) video clips into a single output file.
 *
 * @param clipPaths - Ordered list of input video file paths (must be >= 2).
 * @param outputPath - Path for the output video file.
 * @param options - Stitch configuration (transition mode, codec, fps).
 * @returns The absolute path to the output file.
 *
 * @throws {StitchError} On missing ffmpeg, missing input files, ffmpeg failure, etc.
 *
 * @example
 * ```ts
 * // Simple concat (fastest, lossless)
 * const output = await stitchClips(
 *   ["scene1.mp4", "scene2.mp4", "scene3.mp4"],
 *   "/tmp/video-gen/final.mp4",
 * );
 *
 * // With crossfade transitions
 * const output = await stitchClips(
 *   ["scene1.mp4", "scene2.mp4"],
 *   "/tmp/video-gen/final.mp4",
 *   { transition: "crossfade", transitionDuration: 1.5 },
 * );
 * ```
 */
export async function stitchClips(
	clipPaths: string[],
	outputPath: string,
	options: StitchOptions = {},
): Promise<string> {
	// --- Input validation ---
	if (!Array.isArray(clipPaths) || clipPaths.length < 2) {
		throw new StitchError(
			`stitchClips requires at least 2 clip paths (got ${Array.isArray(clipPaths) ? clipPaths.length : "non-array"}).`,
			"INVALID_ARGUMENTS",
		);
	}

	if (!outputPath || outputPath.trim() === "") {
		throw new StitchError("outputPath must be a non-empty string.", "INVALID_ARGUMENTS");
	}

	const transition = options.transition ?? "none";
	const transitionDuration = options.transitionDuration ?? DEFAULT_TRANSITION_DURATION;
	const fps = options.fps;

	if (transition === "crossfade" && transitionDuration <= 0) {
		throw new StitchError(
			`transitionDuration must be positive (got ${transitionDuration}).`,
			"INVALID_ARGUMENTS",
		);
	}

	// --- Preflight checks ---
	await assertFfmpegAvailable();
	await validateClipPaths(clipPaths);
	await ensureOutputDir(outputPath);

	// --- Dispatch ---
	if (transition === "crossfade") {
		const codec = options.codec ?? DEFAULT_CROSSFADE_CODEC;
		return concatCrossfade(clipPaths, outputPath, transitionDuration, codec, fps);
	}

	// Simple concat
	const codec = options.codec ?? "copy";
	return concatSimple(clipPaths, outputPath, codec);
}
