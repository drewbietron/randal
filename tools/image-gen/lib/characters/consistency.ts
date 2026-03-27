/**
 * Character consistency checker — analyzes generated images against a
 * CharacterProfile using the existing analyzeImage() vision pipeline,
 * scores the result per dimension, and optionally retries with adjusted prompts.
 *
 * Decoupled from concrete image generation — accepts a `generateFn` callback
 * so the MCP handler can control filesystem I/O and provider selection.
 */

import { analyzeImage } from "../image-analyze";
import type {
	CharacterProfile,
	ConsistencyScore,
	CharacterGenerationResult,
} from "./types";
import { CharacterStorageError } from "./types";
import { buildCIDBlock } from "./prompt-builder";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SCORE = 7;
const DEFAULT_MAX_RETRIES = 2;
const SCORE_DIMENSIONS = ["hair", "face", "skin", "build", "age"] as const;

const CONSISTENCY_SYSTEM_PROMPT = `You are a character consistency evaluator. Compare the provided image against a character identity description (CID).
Score each dimension from 1 (completely wrong) to 10 (perfect match).
Return ONLY a JSON object with this exact structure, no markdown, no explanation:
{"overall": N, "hair": N, "face": N, "skin": N, "build": N, "age": N, "details": ["observation 1", "observation 2"]}`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build a user-prompt for the vision model that describes which character
 * features to compare against. The system-prompt is passed separately via
 * `AnalyzeImageOptions.systemPrompt`.
 */
export function buildComparisonPrompt(profile: CharacterProfile): string {
	const cid = buildCIDBlock(profile.physical, profile.name);

	return [
		"Compare this image against the following Character Identity Description (CID):",
		"",
		cid,
		"",
		"Score the following dimensions from 1-10:",
		"- hair: color, length, style, texture match",
		"- face: face shape, jawline, chin, cheekbones, eyes, nose, brows, mouth match",
		"- skin: skin tone, skin details match",
		"- build: body build, height impression match",
		"- age: apparent age match",
		"- overall: weighted average (face=0.3, hair=0.25, skin=0.2, build=0.15, age=0.1)",
		"",
		'In "details", list specific observations where the image differs from the CID.',
	].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Clamp a numeric value to the 1–10 range. */
function clampScore(value: number): number {
	return Math.max(1, Math.min(10, Math.round(value)));
}

/**
 * Parse a consistency score from the vision model's raw response text.
 *
 * Handles three formats:
 *   1. Clean JSON — direct `JSON.parse`
 *   2. Markdown code fences — regex extraction then parse
 *   3. Fallback — regex extraction of individual score fields
 *
 * Defaults missing numeric fields to 5 (neutral) and missing details to [].
 */
export function parseConsistencyResponse(rawResponse: string): ConsistencyScore {
	const defaults: ConsistencyScore = {
		overall: 5,
		hair: 5,
		face: 5,
		skin: 5,
		build: 5,
		age: 5,
		details: [],
	};

	if (!rawResponse || rawResponse.trim() === "") {
		return defaults;
	}

	let jsonText = rawResponse.trim();

	// Attempt 1: strip markdown code fences if present
	const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		jsonText = codeBlockMatch[1].trim();
	}

	// Attempt 2: direct JSON parse
	try {
		const parsed = JSON.parse(jsonText);
		return {
			overall: typeof parsed.overall === "number" ? clampScore(parsed.overall) : defaults.overall,
			hair: typeof parsed.hair === "number" ? clampScore(parsed.hair) : defaults.hair,
			face: typeof parsed.face === "number" ? clampScore(parsed.face) : defaults.face,
			skin: typeof parsed.skin === "number" ? clampScore(parsed.skin) : defaults.skin,
			build: typeof parsed.build === "number" ? clampScore(parsed.build) : defaults.build,
			age: typeof parsed.age === "number" ? clampScore(parsed.age) : defaults.age,
			details: Array.isArray(parsed.details)
				? parsed.details.filter((d: unknown): d is string => typeof d === "string")
				: defaults.details,
		};
	} catch {
		// JSON parse failed — fall through to regex extraction
	}

	// Attempt 3: regex extraction of individual fields
	const scoreRegex = /"(overall|hair|face|skin|build|age)"\s*:\s*(\d+)/g;
	const result = { ...defaults };
	let match: RegExpExecArray | null;

	while ((match = scoreRegex.exec(rawResponse)) !== null) {
		const key = match[1] as keyof Omit<ConsistencyScore, "details">;
		const value = parseInt(match[2], 10);
		if (!isNaN(value)) {
			result[key] = clampScore(value);
		}
	}

	// Try to extract details array via regex
	const detailsMatch = rawResponse.match(/"details"\s*:\s*\[([^\]]*)\]/);
	if (detailsMatch) {
		const detailsStr = detailsMatch[1];
		const detailItems = detailsStr.match(/"([^"]+)"/g);
		if (detailItems) {
			result.details = detailItems.map((d) => d.replace(/^"|"$/g, ""));
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/**
 * Analyze a generated image against a character profile and return a
 * per-dimension consistency score.
 *
 * Uses the existing `analyzeImage()` from image-analyze.ts with a custom
 * system prompt that instructs the vision model to return JSON scores.
 *
 * @throws {CharacterStorageError} With code "CONSISTENCY_ERROR" on analysis failure.
 */
export async function checkConsistency(
	imagePath: string,
	profile: CharacterProfile,
): Promise<ConsistencyScore> {
	try {
		const result = await analyzeImage(
			imagePath,
			buildComparisonPrompt(profile),
			{ systemPrompt: CONSISTENCY_SYSTEM_PROMPT },
		);

		// Prefer rawResponse (the unprocessed model output); fall back to description
		const raw = result.rawResponse ?? result.description;
		return parseConsistencyResponse(raw);
	} catch (error) {
		if (error instanceof CharacterStorageError) throw error;
		throw new CharacterStorageError(
			`Consistency check failed: ${error instanceof Error ? error.message : String(error)}`,
			"CONSISTENCY_ERROR",
			error,
		);
	}
}

// ---------------------------------------------------------------------------
// Drift emphasis
// ---------------------------------------------------------------------------

/**
 * Build an emphasis block for dimensions that scored below the threshold.
 * Prepended to the prompt on retry to correct feature drift.
 *
 * Returns empty string if no dimensions are below threshold.
 */
export function buildDriftEmphasis(
	score: ConsistencyScore,
	profile: CharacterProfile,
	threshold: number = DEFAULT_MIN_SCORE,
): string {
	const p = profile.physical;
	const lines: string[] = [];

	if (score.hair < threshold) {
		lines.push(
			`CRITICAL — hair must be: ${p.hair.color}, ${p.hair.length}, ${p.hair.style}, ${p.hair.texture}`,
		);
	}

	if (score.face < threshold) {
		lines.push(
			`CRITICAL — face must have: ${p.face_shape} shape, ${p.jawline} jawline, ${p.eyes.color} ${p.eyes.shape} eyes, ${p.nose}, ${p.brows}, ${p.mouth}`,
		);
	}

	if (score.skin < threshold) {
		const skinExtra = p.skin_details ? `, ${p.skin_details}` : "";
		lines.push(`CRITICAL — skin must be: ${p.skin_tone}${skinExtra}`);
	}

	if (score.build < threshold) {
		lines.push(`CRITICAL — build must be: ${p.build}, ${p.height}`);
	}

	if (score.age < threshold) {
		lines.push(`CRITICAL — must appear ${p.age}`);
	}

	return lines.join(". ");
}

// ---------------------------------------------------------------------------
// Generate with consistency loop
// ---------------------------------------------------------------------------

/** Options for the generate-with-consistency orchestrator. */
export interface GenerateWithConsistencyOptions {
	/** Callback that generates an image and returns its path. */
	generateFn: (prompt: string) => Promise<{ imagePath: string }>;
	/** The composite prompt (CID + scene + style). */
	prompt: string;
	/** The character profile to verify against. */
	profile: CharacterProfile;
	/** Whether to run consistency verification (default: true). */
	verifyConsistency?: boolean;
	/** Maximum retry attempts (default: 2). */
	maxRetries?: number;
	/** Minimum acceptable overall score (default: 7). */
	minScore?: number;
	/** Character name for the result object. */
	characterName: string;
}

/**
 * Full generate → check → retry loop.
 *
 * 1. If `verifyConsistency` is false, generate once and return immediately.
 * 2. Otherwise, generate up to `maxRetries + 1` total attempts:
 *    - After each generation, run `checkConsistency`.
 *    - If score >= minScore, return immediately.
 *    - If retries remain, prepend drift emphasis to the prompt and retry.
 * 3. After all attempts, return the candidate with the highest overall score.
 *
 * Errors from `generateFn` or `checkConsistency` propagate — the caller
 * (MCP handler) wraps them in its own error response.
 */
export async function generateWithConsistency(
	options: GenerateWithConsistencyOptions,
): Promise<CharacterGenerationResult> {
	const {
		generateFn,
		prompt,
		profile,
		verifyConsistency = true,
		maxRetries = DEFAULT_MAX_RETRIES,
		minScore = DEFAULT_MIN_SCORE,
		characterName,
	} = options;

	// Fast path — no verification requested
	if (!verifyConsistency) {
		const { imagePath } = await generateFn(prompt);
		return {
			image_path: imagePath,
			consistency_score: null,
			retries_used: 0,
			character_name: characterName,
		};
	}

	// Verification loop
	let bestCandidate: {
		imagePath: string;
		score: ConsistencyScore;
		attempt: number;
	} | null = null;

	const totalAttempts = maxRetries + 1;
	let currentPrompt = prompt;

	for (let attempt = 0; attempt < totalAttempts; attempt++) {
		const { imagePath } = await generateFn(currentPrompt);
		const score = await checkConsistency(imagePath, profile);

		// Track best candidate
		if (!bestCandidate || score.overall > bestCandidate.score.overall) {
			bestCandidate = { imagePath, score, attempt };
		}

		// Accept if score meets threshold
		if (score.overall >= minScore) {
			return {
				image_path: imagePath,
				consistency_score: score,
				retries_used: attempt,
				character_name: characterName,
			};
		}

		// Prepare drift-corrected prompt for next attempt (if retries remain)
		if (attempt < totalAttempts - 1) {
			const emphasis = buildDriftEmphasis(score, profile, minScore);
			if (emphasis) {
				currentPrompt = `${emphasis}. ${prompt}`;
			}
		}
	}

	// All attempts exhausted — return the best candidate
	return {
		image_path: bestCandidate!.imagePath,
		consistency_score: bestCandidate!.score,
		retries_used: totalAttempts - 1,
		character_name: characterName,
	};
}
