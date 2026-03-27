/**
 * Character consistency types — interfaces, type aliases, zod schemas, and
 * the character-specific error class.
 *
 * Pure types + zod schemas — zero runtime dependencies on the rest of the codebase.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export type CharacterErrorCode =
	| "NOT_FOUND"
	| "ALREADY_EXISTS"
	| "INVALID_PROFILE"
	| "STORAGE_ERROR"
	| "CONSISTENCY_ERROR";

/** Structured error for character storage and consistency failures. */
export class CharacterStorageError extends Error {
	constructor(
		message: string,
		public readonly code: CharacterErrorCode,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "CharacterStorageError";
	}
}

// ---------------------------------------------------------------------------
// Sub-object interfaces
// ---------------------------------------------------------------------------

/** Structured eye descriptors for a character. */
export interface CharacterEyes {
	color: string;
	shape: string;
	spacing: string;
	details: string;
}

/** Structured hair descriptors for a character. */
export interface CharacterHair {
	color: string;
	length: string;
	style: string;
	texture: string;
	part: string;
}

// ---------------------------------------------------------------------------
// Character physical descriptor (CID)
// ---------------------------------------------------------------------------

/** Full Character Identity Descriptor — 15+ structured physical fields. */
export interface CharacterPhysical {
	age: string;
	gender: string;
	ethnicity: string;
	skin_tone: string;
	build: string;
	height: string;
	face_shape: string;
	jawline: string;
	chin: string;
	cheekbones: string;
	eyes: CharacterEyes;
	nose: string;
	brows: string;
	mouth: string;
	hair: CharacterHair;
	facial_hair?: string;
	skin_details?: string;
	distinguishing_marks?: string;
}

// ---------------------------------------------------------------------------
// Character profile (persisted document)
// ---------------------------------------------------------------------------

/** The full character profile stored to disk as JSON. */
export interface CharacterProfile {
	name: string;
	created_at: string;
	updated_at: string;
	reference_image_path: string | null;
	physical: CharacterPhysical;
	style_anchor: string;
	negative_prompts: string[];
	additional_details: string;
}

// ---------------------------------------------------------------------------
// Consistency scoring
// ---------------------------------------------------------------------------

/** Per-dimension consistency score comparing a generated image to a CID. */
export interface ConsistencyScore {
	overall: number;
	hair: number;
	face: number;
	skin: number;
	build: number;
	age: number;
	details: string[];
}

// ---------------------------------------------------------------------------
// Generation options & result
// ---------------------------------------------------------------------------

/** Options for `generate_with_character` MCP tool. */
export interface GenerateWithCharacterOptions {
	character_name: string;
	prompt: string;
	overrides?: Partial<CharacterPhysical>;
	verify_consistency?: boolean;
	max_retries?: number;
	min_score?: number;
	output_dir?: string;
	filename?: string;
	style_prefix?: string;
	provider?: string;
	model?: string;
}

/** Result of a character-aware image generation. */
export interface CharacterGenerationResult {
	image_path: string;
	consistency_score: ConsistencyScore | null;
	retries_used: number;
	character_name: string;
}

// ---------------------------------------------------------------------------
// Zod schemas (for MCP tool input validation)
// ---------------------------------------------------------------------------

export const CharacterEyesSchema = z.object({
	color: z.string().describe("Eye color, e.g. 'dark brown, almost black'"),
	shape: z.string().describe("Eye shape, e.g. 'almond-shaped, slightly upturned'"),
	spacing: z.string().describe("Eye spacing, e.g. 'average'"),
	details: z.string().describe("Extra eye details, e.g. 'thick lashes, slight epicanthic fold'"),
});

export const CharacterHairSchema = z.object({
	color: z.string().describe("Hair color, e.g. 'jet black'"),
	length: z.string().describe("Hair length, e.g. 'mid-back'"),
	style: z.string().describe("Hair style, e.g. 'straight with slight wave at ends'"),
	texture: z.string().describe("Hair texture, e.g. 'fine, silky'"),
	part: z.string().describe("Hair part, e.g. 'center part'"),
});

export const CharacterPhysicalSchema = z.object({
	age: z.string().describe("Apparent age, e.g. 'mid-30s'"),
	gender: z.string().describe("Gender presentation, e.g. 'female'"),
	ethnicity: z.string().describe("Ethnicity, e.g. 'East Asian'"),
	skin_tone: z.string().describe("Skin tone, e.g. 'warm olive'"),
	build: z.string().describe("Body build, e.g. 'athletic, lean'"),
	height: z.string().describe("Height, e.g. 'tall, ~5\\'10\"'"),
	face_shape: z.string().describe("Face shape, e.g. 'oval with high cheekbones'"),
	jawline: z.string().describe("Jawline, e.g. 'soft, slightly angular'"),
	chin: z.string().describe("Chin, e.g. 'rounded, slight cleft'"),
	cheekbones: z.string().describe("Cheekbones, e.g. 'prominent, high-set'"),
	eyes: CharacterEyesSchema.describe("Structured eye descriptors"),
	nose: z.string().describe("Nose, e.g. 'straight bridge, slightly rounded tip'"),
	brows: z.string().describe("Brows, e.g. 'naturally thick, gently arched'"),
	mouth: z.string().describe("Mouth, e.g. 'full lips, defined cupid\\'s bow'"),
	hair: CharacterHairSchema.describe("Structured hair descriptors"),
	facial_hair: z.string().optional().describe("Facial hair, e.g. 'trimmed goatee' or omit if none"),
	skin_details: z.string().optional().describe("Skin details, e.g. 'light freckles across nose'"),
	distinguishing_marks: z
		.string()
		.optional()
		.describe("Distinguishing marks, e.g. 'small mole above right lip'"),
});
