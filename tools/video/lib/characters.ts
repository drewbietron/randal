/**
 * Character consistency module — re-exports from @randal/image-gen-tool.
 *
 * The actual implementation lives in tools/image-gen/lib/characters/.
 * This re-export maintains the video tool's wrapper import pattern.
 */
export {
	// Storage
	saveCharacter,
	loadCharacter,
	listCharacters,
	updateCharacter,
	characterExists,
	ensureCharacterDir,
	getCharacterDir,
	deleteCharacter,
	// Prompt builder
	buildReferencePrompt,
	buildCharacterPrompt,
	buildCIDBlock,
	// Consistency
	generateWithConsistency,
	checkConsistency,
	// Types & schemas
	CharacterStorageError,
	CharacterPhysicalSchema,
	type CharacterProfile,
	type CharacterPhysical,
	type CharacterGenerationResult,
	type ConsistencyScore,
} from "@randal/image-gen-tool";
