/**
 * Image Generation MCP Server — exposes image generation and analysis tools via stdio MCP protocol.
 *
 * Tools:
 *   generate_image            — Generate still images from text prompts
 *   analyze_image             — Understand/analyze an image with a vision model
 *   list_image_providers      — List available image generation providers
 *   create_character          — Create a persistent character with structured CID
 *   generate_with_character   — Generate an image of a saved character in a scene
 *   list_characters           — List all saved character profiles
 *   get_character             — Get a character's full profile
 *   update_character          — Update a saved character's fields
 *
 * Transport: stdio (for OpenCode MCP integration)
 * Runtime: Bun
 */

import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
	// Character module
	CharacterPhysicalSchema,
	CharacterStorageError,
	analyzeImage,
	buildCharacterPrompt,
	buildReferencePrompt,
	characterExists,
	detectMimeType,
	ensureCharacterDir,
	ensureCorrectExtension,
	generateImage,
	generateWithConsistency,
	getCharacterDir,
	listCharacters as listAllCharacters,
	listImageProviders,
	loadCharacter,
	saveCharacter,
	updateCharacter,
} from "./lib/index";
import type { CharacterPhysical, CharacterProfile } from "./lib/index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OUTPUT_DIR = "/tmp/image-gen/output";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a directory exists, creating it recursively if needed. */
async function ensureDir(dir: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
}

/** Wrap a handler result as MCP text content. */
function ok(result: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
	};
}

/** Wrap an error as MCP error content. */
function err(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
	name: "image-gen",
	version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: generate_image
// ---------------------------------------------------------------------------

server.tool(
	"generate_image",
	"Generate a still image from a text prompt and save it to disk",
	{
		prompt: z.string().describe("Text description of the image to generate"),
		filename: z.string().describe("Output filename (e.g. scene1.png)"),
		output_dir: z
			.string()
			.optional()
			.describe(`Directory to save the image (default: ${DEFAULT_OUTPUT_DIR})`),
		style_prefix: z
			.string()
			.optional()
			.describe("Style modifier prepended to the prompt (e.g. 'Cinematic, 35mm film grain')"),
		model: z
			.string()
			.optional()
			.describe("Override the default model (e.g. 'google/gemini-2.0-flash-exp:free')"),
		provider: z
			.string()
			.optional()
			.describe("Image provider name. Uses first configured provider if omitted"),
	},
	async ({ prompt, filename, output_dir, style_prefix, model, provider }) => {
		try {
			const dir = output_dir ?? DEFAULT_OUTPUT_DIR;
			await ensureDir(dir);

			const result = await generateImage(prompt, {
				style: style_prefix,
				model,
				provider,
			});

			// Detect actual MIME type from the image bytes and correct the filename extension
			const detected = detectMimeType(result.buffer);
			const correctedFilename = ensureCorrectExtension(filename, detected.mimeType);
			const outPath = join(dir, correctedFilename);
			await Bun.write(outPath, result.buffer);

			const stat = Bun.file(outPath);
			return ok({
				path: outPath,
				mimeType: detected.mimeType,
				sizeBytes: stat.size,
				requestedFilename: filename,
				actualFilename: correctedFilename,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: analyze_image
// ---------------------------------------------------------------------------

server.tool(
	"analyze_image",
	"Analyze an image with a vision model to understand its content, style, objects, text, and mood",
	{
		image_path: z.string().describe("Path to the image file to analyze"),
		prompt: z.string().describe("What you want to understand about the image"),
		model: z.string().optional().describe("Vision model to use (default: google/gemini-2.5-flash)"),
	},
	async ({ image_path, prompt, model }) => {
		try {
			const analysis = await analyzeImage(image_path, prompt, { model });

			return ok({
				description: analysis.description,
				objects: analysis.objects,
				text: analysis.text,
				colors: analysis.colors,
				style: analysis.style,
				mood: analysis.mood,
				model: analysis.model,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: list_image_providers
// ---------------------------------------------------------------------------

server.tool(
	"list_image_providers",
	"List available image generation providers and their configuration status",
	{},
	async () => {
		try {
			const providers = listImageProviders();
			const result = providers.map((p) => ({
				name: p.name,
				description: p.description,
				models: p.models,
				configured: p.isConfigured(),
			}));
			return ok(result);
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Character schemas (derived from CharacterPhysicalSchema)
// ---------------------------------------------------------------------------

const CharacterPhysicalOverrideSchema = CharacterPhysicalSchema.deepPartial();

const CharacterUpdateSchema = z.object({
	physical: CharacterPhysicalSchema.deepPartial()
		.optional()
		.describe("Partial physical attribute updates (deep-merged with existing)"),
	style_anchor: z.string().optional().describe("Update the default style anchor"),
	negative_prompts: z.array(z.string()).optional().describe("Replace the negative prompts list"),
	additional_details: z.string().optional().describe("Update additional details text"),
});

// ---------------------------------------------------------------------------
// Tool: create_character
// ---------------------------------------------------------------------------

server.tool(
	"create_character",
	"Create a persistent character with structured physical descriptors (CID). Auto-generates a reference portrait and refines the CID via vision analysis.",
	{
		name: z.string().min(1).describe("Character name (unique identifier, e.g. 'elena-vargas')"),
		physical: CharacterPhysicalSchema.describe(
			"Structured physical attributes — the Character Identity Descriptor (CID)",
		),
		style_anchor: z
			.string()
			.optional()
			.default("Cinematic portrait, natural lighting, photorealistic")
			.describe("Default style for all generations of this character"),
		negative_prompts: z
			.array(z.string())
			.optional()
			.default(["cartoon", "anime", "deformed", "disfigured", "extra limbs"])
			.describe("Prompt elements to avoid in every generation"),
		additional_details: z
			.string()
			.optional()
			.default("")
			.describe("Extra free-text details appended to every generation prompt"),
		generate_reference: z
			.boolean()
			.optional()
			.default(true)
			.describe("Auto-generate a reference headshot portrait (default: true)"),
		provider: z.string().optional().describe("Image provider override"),
		model: z.string().optional().describe("Image model override"),
	},
	async ({
		name,
		physical,
		style_anchor,
		negative_prompts,
		additional_details,
		generate_reference,
		provider,
		model,
	}) => {
		try {
			// 1. Guard: reject duplicate names
			if (await characterExists(name)) {
				return err(
					`Character "${name}" already exists. Use update_character to modify, or choose a different name.`,
				);
			}

			// 2. Build initial profile
			const now = new Date().toISOString();
			const profile: CharacterProfile = {
				name,
				created_at: now,
				updated_at: now,
				reference_image_path: null,
				physical,
				style_anchor,
				negative_prompts,
				additional_details,
			};

			// 3. Save initial profile (before image gen, so partial state is recoverable)
			await saveCharacter(profile);

			// 4. Optionally generate reference portrait
			if (generate_reference) {
				const refPrompt = buildReferencePrompt(profile);
				const result = await generateImage(refPrompt, {
					model,
					provider,
					// Note: do NOT pass style — buildReferencePrompt() embeds the style_anchor already
				});

				// Save reference image to character directory
				const charDir = getCharacterDir();
				await ensureCharacterDir();
				const detected = detectMimeType(result.buffer);
				const refFilename = ensureCorrectExtension(`${name}_reference.png`, detected.mimeType);
				const refPath = join(charDir, refFilename);
				await Bun.write(refPath, result.buffer);

				// 5. Analyze the reference to see what the model actually rendered
				const analysis = await analyzeImage(
					refPath,
					[
						"Describe this person's physical appearance in detail.",
						"Focus on: face shape, jawline, chin, cheekbones, eye color/shape, nose, brows, mouth/lips,",
						"skin tone, hair color/length/style/texture, build, apparent age, any distinguishing marks.",
						"Be precise and specific — this will be used to reproduce this exact person in future images.",
					].join(" "),
				);

				// 6. Update profile with reference path and analysis
				//    Do NOT overwrite user-provided CID fields — the user's structured input
				//    is the source of truth. The analysis is stored as additional_details
				//    for informational purposes only.
				profile.reference_image_path = refPath;
				if (!profile.additional_details) {
					profile.additional_details = `Reference analysis: ${analysis.description}`;
				} else {
					profile.additional_details += ` | Reference analysis: ${analysis.description}`;
				}
				profile.updated_at = new Date().toISOString();
				await saveCharacter(profile);
			}

			// 7. Return the final profile
			return ok(profile);
		} catch (error) {
			if (error instanceof CharacterStorageError) {
				return err(`[${error.code}] ${error.message}`);
			}
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: generate_with_character
// ---------------------------------------------------------------------------

server.tool(
	"generate_with_character",
	"Generate an image of a saved character in a specific scene. The character's CID is automatically prepended to the prompt. Optionally verifies consistency and retries if the result drifts.",
	{
		character_name: z
			.string()
			.min(1)
			.describe("Name of an existing character (as passed to create_character)"),
		prompt: z
			.string()
			.min(1)
			.describe("Scene/action description — the character's identity is prepended automatically"),
		overrides: CharacterPhysicalOverrideSchema.optional().describe(
			"Temporary physical attribute overrides for this generation only (e.g., different hairstyle). Does NOT modify the saved profile.",
		),
		verify_consistency: z
			.boolean()
			.optional()
			.default(true)
			.describe(
				"Analyze the output against the CID and retry if consistency score < min_score (default: true)",
			),
		max_retries: z
			.number()
			.int()
			.min(0)
			.max(5)
			.optional()
			.default(2)
			.describe("Maximum retry attempts when consistency is low (default: 2)"),
		min_score: z
			.number()
			.min(1)
			.max(10)
			.optional()
			.default(7)
			.describe("Minimum consistency score (1-10) to accept without retrying (default: 7)"),
		output_dir: z
			.string()
			.optional()
			.describe(`Directory to save the image (default: ${DEFAULT_OUTPUT_DIR})`),
		filename: z
			.string()
			.optional()
			.describe("Output filename (default: auto-generated as {character_name}_{uuid}.png)"),
		style_prefix: z
			.string()
			.optional()
			.describe("Override the character's style_anchor for this generation only"),
		provider: z.string().optional().describe("Image provider override"),
		model: z.string().optional().describe("Image model override"),
	},
	async ({
		character_name,
		prompt,
		overrides,
		verify_consistency,
		max_retries,
		min_score,
		output_dir,
		filename,
		style_prefix,
		provider,
		model,
	}) => {
		try {
			// 1. Load the character
			const profile = await loadCharacter(character_name);

			// 2. If style_prefix provided, temporarily override style_anchor for prompt building
			const effectiveProfile = style_prefix ? { ...profile, style_anchor: style_prefix } : profile;

			// 3. Build the composite prompt (CID + scene + style + negatives)
			const compositePrompt = buildCharacterPrompt(
				effectiveProfile,
				prompt,
				overrides as Partial<CharacterPhysical> | undefined,
			);

			// 4. Set up output path
			const dir = output_dir ?? DEFAULT_OUTPUT_DIR;
			await ensureDir(dir);
			const outFilename = filename ?? `${character_name}-${crypto.randomUUID().slice(0, 8)}.png`;

			// 5. Define the generate-and-save function for the consistency wrapper
			const generateFn = async (currentPrompt: string): Promise<{ imagePath: string }> => {
				const result = await generateImage(currentPrompt, {
					model,
					provider,
					// Do NOT pass style — the prompt already contains the style anchor
				});
				const detected = detectMimeType(result.buffer);
				const corrected = ensureCorrectExtension(outFilename, detected.mimeType);
				const outPath = join(dir, corrected);
				await Bun.write(outPath, result.buffer);
				return { imagePath: outPath };
			};

			// 6. Generate — with or without consistency verification
			const genResult = await generateWithConsistency({
				generateFn,
				prompt: compositePrompt,
				profile,
				verifyConsistency: verify_consistency,
				maxRetries: max_retries,
				minScore: min_score,
				characterName: character_name,
			});

			return ok({
				image_path: genResult.image_path,
				character_name: genResult.character_name,
				consistency_score: genResult.consistency_score,
				retries_used: genResult.retries_used,
			});
		} catch (error) {
			if (error instanceof CharacterStorageError) {
				return err(`[${error.code}] ${error.message}`);
			}
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: list_characters
// ---------------------------------------------------------------------------

server.tool(
	"list_characters",
	"List all saved character profiles with summary info (name, creation date, reference image path)",
	{},
	async () => {
		try {
			const characters = await listAllCharacters();
			const summaries = characters.map((c) => ({
				name: c.name,
				created_at: c.created_at,
				updated_at: c.updated_at,
				reference_image_path: c.reference_image_path,
				style_anchor: c.style_anchor,
			}));
			return ok(summaries);
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: get_character
// ---------------------------------------------------------------------------

server.tool(
	"get_character",
	"Get the full profile for a saved character, including all CID fields and reference image path",
	{
		name: z.string().min(1).describe("Character name"),
	},
	async ({ name }) => {
		try {
			const profile = await loadCharacter(name);
			return ok(profile);
		} catch (error) {
			if (error instanceof CharacterStorageError) {
				return err(`[${error.code}] ${error.message}`);
			}
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: update_character
// ---------------------------------------------------------------------------

server.tool(
	"update_character",
	"Update a saved character's profile fields. Deep-merges physical attributes. Does not regenerate the reference image (use create_character with a new name for that).",
	{
		name: z.string().min(1).describe("Character name to update"),
		updates: CharacterUpdateSchema.describe("Fields to update (all optional, deep-merged)"),
	},
	async ({ name, updates }) => {
		try {
			const updated = await updateCharacter(name, updates);
			return ok(updated);
		} catch (error) {
			if (error instanceof CharacterStorageError) {
				return err(`[${error.code}] ${error.message}`);
			}
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
