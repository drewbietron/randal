/**
 * Shared test fixtures for character module tests.
 */

import type { CharacterPhysical, CharacterProfile } from "../types";

/** A complete CharacterPhysical for testing. All fields populated. */
export function makePhysical(overrides?: Partial<CharacterPhysical>): CharacterPhysical {
	return {
		age: "mid-30s",
		gender: "female",
		ethnicity: "East Asian",
		skin_tone: "warm olive",
		build: "athletic, lean",
		height: "tall, ~5'10\"",
		face_shape: "oval with high cheekbones",
		jawline: "soft, slightly angular",
		chin: "rounded, slight cleft",
		cheekbones: "prominent, high-set",
		eyes: {
			color: "dark brown, almost black",
			shape: "almond-shaped, slightly upturned",
			spacing: "average",
			details: "thick lashes, slight epicanthic fold",
			...(overrides?.eyes ?? {}),
		},
		nose: "straight bridge, slightly rounded tip",
		brows: "naturally thick, gently arched",
		mouth: "full lips, defined cupid's bow",
		hair: {
			color: "jet black",
			length: "mid-back",
			style: "straight with slight wave at ends",
			texture: "fine, silky",
			part: "center part",
			...(overrides?.hair ?? {}),
		},
		...overrides,
	};
}

/** A complete CharacterProfile for testing. */
export function makeProfile(overrides?: Partial<CharacterProfile>): CharacterProfile {
	return {
		name: "test-character",
		created_at: "2026-03-27T18:00:00.000Z",
		updated_at: "2026-03-27T18:00:00.000Z",
		reference_image_path: null,
		physical: makePhysical(overrides?.physical as unknown as Partial<CharacterPhysical>),
		style_anchor: "Cinematic portrait, natural lighting, photorealistic",
		negative_prompts: ["cartoon", "anime", "deformed"],
		additional_details: "",
		...overrides,
	};
}
