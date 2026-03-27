/**
 * Character prompt builder — converts a CharacterProfile into optimised
 * generation prompts following CID-first ordering.
 *
 * Research-backed ordering:
 *   1. Character identity (CID block)
 *   2. Scene description
 *   3. Style anchor
 *
 * All functions are pure — no side effects, no API calls.
 */

import type { CharacterPhysical, CharacterProfile } from "./types";

// ---------------------------------------------------------------------------
// Physical merge
// ---------------------------------------------------------------------------

/**
 * Deep-merge overrides into a base CharacterPhysical without mutating `base`.
 * Partial overrides for `eyes` and `hair` are merged individually so that
 * e.g. overriding only `eyes.color` preserves `eyes.shape`.
 */
export function mergePhysical(
	base: CharacterPhysical,
	overrides?: Partial<CharacterPhysical>,
): CharacterPhysical {
	if (!overrides || Object.keys(overrides).length === 0) {
		return { ...base, eyes: { ...base.eyes }, hair: { ...base.hair } };
	}

	return {
		...base,
		...overrides,
		eyes: { ...base.eyes, ...(overrides.eyes ?? {}) },
		hair: { ...base.hair, ...(overrides.hair ?? {}) },
	};
}

// ---------------------------------------------------------------------------
// CID block
// ---------------------------------------------------------------------------

/**
 * Build a natural-language Character Identity Description (CID) block
 * from structured physical fields.
 *
 * Grouping order (character identity FIRST per research):
 *   Identity → Skin/build → Face structure → Eyes → Nose/brows/mouth →
 *   Hair → Optional fields
 */
export function buildCIDBlock(physical: CharacterPhysical, name?: string): string {
	const groups: string[] = [];

	// Identity line
	const nameClause = name ? ` named ${name}` : "";
	groups.push(
		`A ${physical.age} ${physical.gender} of ${physical.ethnicity} descent${nameClause}`,
	);

	// Skin / build
	groups.push(
		`with ${physical.skin_tone} skin, ${physical.build} build, ${physical.height}`,
	);

	// Face structure
	groups.push(
		`Face: ${physical.face_shape} face shape, ${physical.jawline} jawline, ${physical.chin} chin, ${physical.cheekbones} cheekbones`,
	);

	// Eyes
	groups.push(
		`Eyes: ${physical.eyes.color}, ${physical.eyes.shape}, ${physical.eyes.spacing} spacing, ${physical.eyes.details}`,
	);

	// Nose / brows / mouth
	groups.push(
		`Nose: ${physical.nose}. Brows: ${physical.brows}. Mouth: ${physical.mouth}`,
	);

	// Hair
	groups.push(
		`Hair: ${physical.hair.color}, ${physical.hair.length}, ${physical.hair.style}, ${physical.hair.texture}, ${physical.hair.part}`,
	);

	// Optional fields — only include when truthy
	if (physical.facial_hair) {
		groups.push(`Facial hair: ${physical.facial_hair}`);
	}
	if (physical.skin_details) {
		groups.push(`Skin details: ${physical.skin_details}`);
	}
	if (physical.distinguishing_marks) {
		groups.push(`Distinguishing marks: ${physical.distinguishing_marks}`);
	}

	return groups.join(". ") + ".";
}

// ---------------------------------------------------------------------------
// Composite prompt builders
// ---------------------------------------------------------------------------

/**
 * Build a complete generation prompt with CID-first ordering:
 *   [CID block]. [additional_details]. [scenePrompt]. [style_anchor]. Avoid: [negatives].
 *
 * The style anchor is embedded in the prompt text directly — NOT passed
 * via the provider's `style` option — to maintain CID-first ordering.
 */
export function buildCharacterPrompt(
	profile: CharacterProfile,
	scenePrompt: string,
	overrides?: Partial<CharacterPhysical>,
): string {
	const merged = mergePhysical(profile.physical, overrides);
	const parts: string[] = [];

	// 1. CID block (character identity FIRST)
	parts.push(buildCIDBlock(merged, profile.name));

	// 2. Additional details (if present)
	if (profile.additional_details) {
		parts.push(profile.additional_details);
	}

	// 3. Scene prompt
	parts.push(scenePrompt);

	// 4. Style anchor
	if (profile.style_anchor) {
		parts.push(profile.style_anchor + ".");
	}

	// 5. Negative prompts
	if (profile.negative_prompts.length > 0) {
		parts.push(`Avoid: ${profile.negative_prompts.join(", ")}.`);
	}

	return parts.join(" ");
}

/**
 * Build a prompt specifically for the initial reference portrait.
 * Uses a neutral headshot framing — does NOT include additional_details
 * (the reference should be a clean baseline).
 */
export function buildReferencePrompt(profile: CharacterProfile): string {
	const cid = buildCIDBlock(profile.physical, profile.name);
	const parts = [
		cid,
		"Professional headshot, centered framing, neutral expression, solid white background, studio lighting, sharp focus, high detail.",
	];

	if (profile.style_anchor) {
		parts.push(profile.style_anchor + ".");
	}

	return parts.join(" ");
}

/**
 * Join the negative prompts array into a single comma-separated string.
 * Returns empty string if the array is empty.
 */
export function buildNegativePrompt(profile: CharacterProfile): string {
	return profile.negative_prompts.join(", ");
}
