/**
 * Character storage — filesystem CRUD for character profiles.
 *
 * Characters are stored as JSON files at `~/.config/randal/characters/`.
 * Set the `RANDAL_CHARACTER_DIR` environment variable to override the
 * storage directory (useful for testing and CI).
 *
 * Uses Bun.write(), Bun.file(), and node:fs/promises — matching the
 * patterns in mcp-server.ts (ensureDir) and image-analyze.ts (Bun.file).
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CharacterProfile } from "./types";
import { CharacterStorageError } from "./types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a character name to a filesystem-safe slug.
 * Throws if the resulting slug is empty.
 */
function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	if (!slug) {
		throw new CharacterStorageError(
			`Invalid character name "${name}" — produces an empty slug`,
			"INVALID_PROFILE",
		);
	}
	return slug;
}

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

/**
 * Return the character storage directory path.
 * Respects the `RANDAL_CHARACTER_DIR` env var override.
 * Pure function — does NOT create the directory.
 */
export function getCharacterDir(): string {
	if (process.env.RANDAL_CHARACTER_DIR) return process.env.RANDAL_CHARACTER_DIR;
	return join(homedir(), ".config", "randal", "characters");
}

/**
 * Ensure the character storage directory exists, creating it recursively.
 * Returns the directory path.
 */
export async function ensureCharacterDir(): Promise<string> {
	const dir = getCharacterDir();
	await mkdir(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Return the full filesystem path for a character's JSON file. */
export function characterPath(name: string): string {
	return join(getCharacterDir(), `${slugify(name)}.json`);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/** Check whether a character with the given name exists on disk. */
export async function characterExists(name: string): Promise<boolean> {
	const file = Bun.file(characterPath(name));
	return file.exists();
}

/**
 * Persist a character profile to disk.
 * Updates the `updated_at` timestamp automatically.
 */
export async function saveCharacter(profile: CharacterProfile): Promise<void> {
	await ensureCharacterDir();
	profile.updated_at = new Date().toISOString();
	const path = characterPath(profile.name);
	await Bun.write(path, JSON.stringify(profile, null, "\t"));
}

/**
 * Load a character profile from disk.
 * Throws `CharacterStorageError("NOT_FOUND")` if the file does not exist.
 * Throws `CharacterStorageError("INVALID_PROFILE")` if the JSON is malformed.
 */
export async function loadCharacter(name: string): Promise<CharacterProfile> {
	const path = characterPath(name);
	const file = Bun.file(path);

	if (!(await file.exists())) {
		throw new CharacterStorageError(`Character "${name}" not found`, "NOT_FOUND");
	}

	try {
		const text = await file.text();
		return JSON.parse(text) as CharacterProfile;
	} catch (e) {
		throw new CharacterStorageError(
			`Failed to parse character profile for "${name}"`,
			"INVALID_PROFILE",
			e,
		);
	}
}

/**
 * List all saved character profiles, sorted by name.
 * Skips malformed JSON files (logs warning to stderr, does not throw).
 */
export async function listCharacters(): Promise<CharacterProfile[]> {
	await ensureCharacterDir();
	const dir = getCharacterDir();
	const entries = await readdir(dir);
	const profiles: CharacterProfile[] = [];

	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;

		try {
			const file = Bun.file(join(dir, entry));
			const text = await file.text();
			const profile = JSON.parse(text) as CharacterProfile;
			profiles.push(profile);
		} catch (e) {
			console.error(`[characters] Skipping malformed file ${entry}: ${e}`);
		}
	}

	return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Update a character profile by deep-merging the provided fields.
 * Preserves `name` and `created_at` — they cannot be overwritten.
 * Deep-merges `physical.eyes` and `physical.hair` sub-objects individually.
 */
export async function updateCharacter(
	name: string,
	updates: Partial<Omit<CharacterProfile, "name" | "created_at">>,
): Promise<CharacterProfile> {
	const existing = await loadCharacter(name);

	// Deep-merge physical sub-objects
	const mergedPhysical = updates.physical
		? {
				...existing.physical,
				...updates.physical,
				eyes: { ...existing.physical.eyes, ...(updates.physical.eyes ?? {}) },
				hair: { ...existing.physical.hair, ...(updates.physical.hair ?? {}) },
			}
		: existing.physical;

	const merged: CharacterProfile = {
		...existing,
		...updates,
		physical: mergedPhysical,
		name: existing.name,
		created_at: existing.created_at,
	};

	await saveCharacter(merged);
	return merged;
}

/**
 * Delete a character profile from disk.
 * Also removes the reference image if it exists.
 * Throws `CharacterStorageError("NOT_FOUND")` if the character does not exist.
 */
export async function deleteCharacter(name: string): Promise<void> {
	const profile = await loadCharacter(name);
	await rm(characterPath(name));

	if (profile.reference_image_path) {
		try {
			await rm(profile.reference_image_path);
		} catch {
			/* ignore — file may not exist */
		}
	}
}
