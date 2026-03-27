import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	characterExists,
	characterPath,
	deleteCharacter,
	ensureCharacterDir,
	getCharacterDir,
	listCharacters,
	loadCharacter,
	saveCharacter,
	updateCharacter,
} from "../storage";
import { CharacterStorageError } from "../types";
import { makeProfile } from "./fixtures";

// ---------------------------------------------------------------------------
// Test isolation via RANDAL_CHARACTER_DIR
// ---------------------------------------------------------------------------

let tempDir: string;
const originalCharDir = process.env.RANDAL_CHARACTER_DIR;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "char-test-"));
	process.env.RANDAL_CHARACTER_DIR = tempDir;
});

afterEach(async () => {
	if (originalCharDir !== undefined) {
		process.env.RANDAL_CHARACTER_DIR = originalCharDir;
	} else {
		process.env.RANDAL_CHARACTER_DIR = undefined;
	}
	try {
		await rm(tempDir, { recursive: true });
	} catch {
		/* ignore */
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storage", () => {
	describe("getCharacterDir / ensureCharacterDir", () => {
		test("getCharacterDir respects RANDAL_CHARACTER_DIR env var", () => {
			expect(getCharacterDir()).toBe(tempDir);
		});

		test("ensureCharacterDir creates the directory", async () => {
			const subDir = join(tempDir, "nested", "deep");
			process.env.RANDAL_CHARACTER_DIR = subDir;
			await ensureCharacterDir();
			const entries = await readdir(subDir);
			expect(entries).toBeArray();
		});
	});

	describe("saveCharacter + loadCharacter", () => {
		test("round-trips a full profile", async () => {
			const profile = makeProfile();
			await saveCharacter(profile);
			const loaded = await loadCharacter("test-character");
			expect(loaded.name).toBe(profile.name);
			expect(loaded.physical.eyes.color).toBe(profile.physical.eyes.color);
			expect(loaded.physical.hair.style).toBe(profile.physical.hair.style);
			expect(loaded.negative_prompts).toEqual(profile.negative_prompts);
		});

		test("updates updated_at timestamp on save", async () => {
			const profile = makeProfile({
				updated_at: "2020-01-01T00:00:00.000Z",
			});
			await saveCharacter(profile);
			const loaded = await loadCharacter("test-character");
			expect(loaded.updated_at).not.toBe("2020-01-01T00:00:00.000Z");
			expect(new Date(loaded.updated_at).getFullYear()).toBeGreaterThanOrEqual(2026);
		});

		test("saves with tab-indented JSON", async () => {
			const profile = makeProfile();
			await saveCharacter(profile);
			const path = characterPath("test-character");
			const text = await Bun.file(path).text();
			expect(text).toContain("\t");
			expect(text).not.toMatch(/^ {2}/m); // no space indentation
		});
	});

	describe("characterExists", () => {
		test("returns false for nonexistent character", async () => {
			expect(await characterExists("nobody")).toBe(false);
		});

		test("returns true after save", async () => {
			await saveCharacter(makeProfile());
			expect(await characterExists("test-character")).toBe(true);
		});
	});

	describe("listCharacters", () => {
		test("returns empty array when no characters", async () => {
			const result = await listCharacters();
			expect(result).toEqual([]);
		});

		test("returns all saved characters sorted by name", async () => {
			await saveCharacter(makeProfile({ name: "zara" }));
			await saveCharacter(makeProfile({ name: "alice" }));
			await saveCharacter(makeProfile({ name: "marco" }));
			const result = await listCharacters();
			expect(result).toHaveLength(3);
			expect(result[0].name).toBe("alice");
			expect(result[1].name).toBe("marco");
			expect(result[2].name).toBe("zara");
		});

		test("skips malformed JSON files without throwing", async () => {
			await saveCharacter(makeProfile({ name: "valid" }));
			// Write a malformed file
			await Bun.write(join(tempDir, "broken.json"), "not json {{{");
			const result = await listCharacters();
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe("valid");
		});
	});

	describe("updateCharacter", () => {
		test("deep-merges physical.hair without losing other hair fields", async () => {
			await saveCharacter(makeProfile());
			const updated = await updateCharacter("test-character", {
				// biome-ignore lint/suspicious/noExplicitAny: partial override for testing deep merge
				physical: { hair: { color: "platinum blonde" } } as any,
			});
			expect(updated.physical.hair.color).toBe("platinum blonde");
			expect(updated.physical.hair.style).toBe("straight with slight wave at ends");
			expect(updated.physical.hair.texture).toBe("fine, silky");
		});

		test("deep-merges physical.eyes without losing other eye fields", async () => {
			await saveCharacter(makeProfile());
			const updated = await updateCharacter("test-character", {
				// biome-ignore lint/suspicious/noExplicitAny: partial override for testing deep merge
				physical: { eyes: { color: "bright green" } } as any,
			});
			expect(updated.physical.eyes.color).toBe("bright green");
			expect(updated.physical.eyes.shape).toBe("almond-shaped, slightly upturned");
			expect(updated.physical.eyes.spacing).toBe("average");
		});

		test("preserves name and created_at", async () => {
			const original = makeProfile();
			await saveCharacter(original);
			const updated = await updateCharacter("test-character", {
				style_anchor: "watercolor",
			});
			expect(updated.name).toBe("test-character");
			expect(updated.created_at).toBe(original.created_at);
			expect(updated.style_anchor).toBe("watercolor");
		});

		test("throws NOT_FOUND for nonexistent character", async () => {
			try {
				await updateCharacter("nonexistent", { style_anchor: "x" });
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(CharacterStorageError);
				expect((e as CharacterStorageError).code).toBe("NOT_FOUND");
			}
		});
	});

	describe("deleteCharacter", () => {
		test("removes JSON file from disk", async () => {
			await saveCharacter(makeProfile());
			expect(await characterExists("test-character")).toBe(true);
			await deleteCharacter("test-character");
			expect(await characterExists("test-character")).toBe(false);
		});

		test("throws NOT_FOUND for nonexistent character", async () => {
			try {
				await deleteCharacter("ghost");
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(CharacterStorageError);
				expect((e as CharacterStorageError).code).toBe("NOT_FOUND");
			}
		});
	});

	describe("slugify edge cases (tested via characterPath/save/load)", () => {
		test("lowercases and replaces spaces with hyphens", async () => {
			await saveCharacter(makeProfile({ name: "Elena Vargas" }));
			const path = characterPath("Elena Vargas");
			expect(path).toContain("elena-vargas.json");
		});

		test("strips special characters", async () => {
			await saveCharacter(makeProfile({ name: "Dr. O'Brien!" }));
			const path = characterPath("Dr. O'Brien!");
			expect(path).toContain("dr-o-brien.json");
		});

		test("throws on empty slug result", () => {
			try {
				characterPath("!!!---");
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(CharacterStorageError);
				expect((e as CharacterStorageError).code).toBe("INVALID_PROFILE");
			}
		});
	});

	describe("loadCharacter error handling", () => {
		test("throws NOT_FOUND for missing file", async () => {
			try {
				await loadCharacter("does-not-exist");
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(CharacterStorageError);
				expect((e as CharacterStorageError).code).toBe("NOT_FOUND");
			}
		});

		test("throws INVALID_PROFILE for malformed JSON", async () => {
			await Bun.write(join(tempDir, "bad.json"), "{ broken json }}}");
			try {
				await loadCharacter("bad");
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(CharacterStorageError);
				expect((e as CharacterStorageError).code).toBe("INVALID_PROFILE");
			}
		});
	});
});
