/**
 * Character consistency module — barrel export.
 */

// ---------------------------------------------------------------------------
// Types & schemas
// ---------------------------------------------------------------------------

export type {
	CharacterEyes,
	CharacterHair,
	CharacterPhysical,
	CharacterProfile,
	ConsistencyScore,
	GenerateWithCharacterOptions,
	CharacterGenerationResult,
	CharacterErrorCode,
} from "./types";

export {
	CharacterStorageError,
	CharacterEyesSchema,
	CharacterHairSchema,
	CharacterPhysicalSchema,
} from "./types";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export {
	getCharacterDir,
	ensureCharacterDir,
	characterPath,
	characterExists,
	saveCharacter,
	loadCharacter,
	listCharacters,
	updateCharacter,
	deleteCharacter,
} from "./storage";

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export {
	mergePhysical,
	buildCIDBlock,
	buildCharacterPrompt,
	buildNegativePrompt,
	buildReferencePrompt,
} from "./prompt-builder";

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

export {
	checkConsistency,
	generateWithConsistency,
	parseConsistencyResponse,
	buildComparisonPrompt,
	buildDriftEmphasis,
} from "./consistency";

export type { GenerateWithConsistencyOptions } from "./consistency";
