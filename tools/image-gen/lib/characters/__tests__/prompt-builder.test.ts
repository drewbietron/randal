import { describe, expect, test } from "bun:test";
import { makePhysical, makeProfile } from "./fixtures";
import {
	buildCIDBlock,
	buildCharacterPrompt,
	buildNegativePrompt,
	buildReferencePrompt,
	mergePhysical,
} from "../prompt-builder";

// ---------------------------------------------------------------------------
// Tests — all pure functions, no async, no mocking
// ---------------------------------------------------------------------------

describe("prompt-builder", () => {
	describe("mergePhysical", () => {
		test("returns shallow copy when no overrides", () => {
			const base = makePhysical();
			const result = mergePhysical(base);
			expect(result).toEqual(base);
			expect(result).not.toBe(base); // different object reference
			expect(result.eyes).not.toBe(base.eyes);
			expect(result.hair).not.toBe(base.hair);
		});

		test("overrides top-level string field", () => {
			const base = makePhysical();
			const result = mergePhysical(base, { age: "early 20s" });
			expect(result.age).toBe("early 20s");
			expect(result.gender).toBe(base.gender); // unchanged
		});

		test("deep-merges eyes (override only color, keep shape)", () => {
			const base = makePhysical();
			const result = mergePhysical(base, { eyes: { color: "bright green" } as any });
			expect(result.eyes.color).toBe("bright green");
			expect(result.eyes.shape).toBe(base.eyes.shape);
			expect(result.eyes.spacing).toBe(base.eyes.spacing);
			expect(result.eyes.details).toBe(base.eyes.details);
		});

		test("deep-merges hair (override only style, keep color)", () => {
			const base = makePhysical();
			const result = mergePhysical(base, { hair: { style: "buzzcut" } as any });
			expect(result.hair.style).toBe("buzzcut");
			expect(result.hair.color).toBe(base.hair.color);
			expect(result.hair.length).toBe(base.hair.length);
		});

		test("does not mutate the base object", () => {
			const base = makePhysical();
			const originalAge = base.age;
			const originalEyeColor = base.eyes.color;
			mergePhysical(base, { age: "old", eyes: { color: "red" } as any });
			expect(base.age).toBe(originalAge);
			expect(base.eyes.color).toBe(originalEyeColor);
		});
	});

	describe("buildCIDBlock", () => {
		test("includes all required fields in output", () => {
			const physical = makePhysical();
			const block = buildCIDBlock(physical);
			expect(block).toContain(physical.age);
			expect(block).toContain(physical.gender);
			expect(block).toContain(physical.ethnicity);
			expect(block).toContain(physical.skin_tone);
			expect(block).toContain(physical.build);
			expect(block).toContain(physical.face_shape);
			expect(block).toContain(physical.eyes.color);
			expect(block).toContain(physical.hair.color);
			expect(block).toContain(physical.nose);
			expect(block).toContain(physical.brows);
			expect(block).toContain(physical.mouth);
		});

		test("includes name when provided", () => {
			const physical = makePhysical();
			const block = buildCIDBlock(physical, "Elena");
			expect(block).toContain("named Elena");
		});

		test("omits name clause when name is undefined", () => {
			const physical = makePhysical();
			const block = buildCIDBlock(physical);
			expect(block).not.toContain("named");
		});

		test("includes optional fields when truthy", () => {
			const physical = makePhysical({
				facial_hair: "trimmed goatee",
				skin_details: "light freckles",
				distinguishing_marks: "scar on left cheek",
			});
			const block = buildCIDBlock(physical);
			expect(block).toContain("Facial hair: trimmed goatee");
			expect(block).toContain("Skin details: light freckles");
			expect(block).toContain("Distinguishing marks: scar on left cheek");
		});

		test("omits optional fields when falsy", () => {
			const physical = makePhysical();
			const block = buildCIDBlock(physical);
			expect(block).not.toContain("Facial hair:");
			expect(block).not.toContain("Skin details:");
			expect(block).not.toContain("Distinguishing marks:");
		});

		test("output starts with identity line (age, gender, ethnicity)", () => {
			const physical = makePhysical();
			const block = buildCIDBlock(physical);
			expect(block).toMatch(/^A mid-30s female of East Asian descent/);
		});
	});

	describe("buildCharacterPrompt", () => {
		test("CID block appears before scene prompt", () => {
			const profile = makeProfile();
			const prompt = buildCharacterPrompt(profile, "walking in park");
			const cidPos = prompt.indexOf("mid-30s female");
			const scenePos = prompt.indexOf("walking in park");
			expect(cidPos).toBeLessThan(scenePos);
		});

		test("scene prompt appears before style anchor", () => {
			const profile = makeProfile();
			const prompt = buildCharacterPrompt(profile, "walking in park");
			const scenePos = prompt.indexOf("walking in park");
			const stylePos = prompt.indexOf("Cinematic portrait");
			expect(scenePos).toBeLessThan(stylePos);
		});

		test("negative prompts appended as 'Avoid: ...'", () => {
			const profile = makeProfile();
			const prompt = buildCharacterPrompt(profile, "scene");
			expect(prompt).toContain("Avoid: cartoon, anime, deformed.");
		});

		test("empty negative_prompts produces no 'Avoid' clause", () => {
			const profile = makeProfile({ negative_prompts: [] });
			const prompt = buildCharacterPrompt(profile, "scene");
			expect(prompt).not.toContain("Avoid:");
		});

		test("overrides applied to CID block without mutating profile", () => {
			const profile = makeProfile();
			const originalHairColor = profile.physical.hair.color;
			const prompt = buildCharacterPrompt(profile, "scene", {
				hair: { color: "platinum blonde" } as any,
			});
			expect(prompt).toContain("platinum blonde");
			expect(profile.physical.hair.color).toBe(originalHairColor);
		});

		test("additional_details included between CID and scene when present", () => {
			const profile = makeProfile({ additional_details: "Always wears a red scarf" });
			const prompt = buildCharacterPrompt(profile, "at the market");
			const detailsPos = prompt.indexOf("red scarf");
			const scenePos = prompt.indexOf("at the market");
			expect(detailsPos).toBeLessThan(scenePos);
		});
	});

	describe("buildReferencePrompt", () => {
		test("includes CID block", () => {
			const profile = makeProfile();
			const prompt = buildReferencePrompt(profile);
			expect(prompt).toContain("mid-30s female");
			expect(prompt).toContain("East Asian");
		});

		test("includes 'Professional headshot' and 'studio lighting'", () => {
			const profile = makeProfile();
			const prompt = buildReferencePrompt(profile);
			expect(prompt).toContain("Professional headshot");
			expect(prompt).toContain("studio lighting");
		});

		test("includes style_anchor", () => {
			const profile = makeProfile({ style_anchor: "oil painting, Renaissance" });
			const prompt = buildReferencePrompt(profile);
			expect(prompt).toContain("oil painting, Renaissance");
		});

		test("does NOT include additional_details", () => {
			const profile = makeProfile({ additional_details: "secret detail" });
			const prompt = buildReferencePrompt(profile);
			expect(prompt).not.toContain("secret detail");
		});
	});

	describe("buildNegativePrompt", () => {
		test("joins array with comma-space", () => {
			const profile = makeProfile({ negative_prompts: ["cartoon", "anime", "blurry"] });
			const result = buildNegativePrompt(profile);
			expect(result).toBe("cartoon, anime, blurry");
		});

		test("returns empty string for empty array", () => {
			const profile = makeProfile({ negative_prompts: [] });
			const result = buildNegativePrompt(profile);
			expect(result).toBe("");
		});
	});
});
