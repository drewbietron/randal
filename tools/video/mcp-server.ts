/**
 * Video MCP Server — exposes video production tools via stdio MCP protocol.
 *
 * Tools:
 *   generate_asset    — Generate still images (Gemini 3.1 Flash via OpenRouter)
 *   generate_clip     — Generate video clips (Veo or other providers)
 *   stitch_clips      — Concatenate clips with ffmpeg
 *   compose_video     — Rich composition via Remotion
 *   scaffold_project  — Create a new Remotion project from template
 *   list_providers    — List available video generation providers
 *
 * Transport: stdio (for OpenCode MCP integration)
 * Runtime: Bun
 */

import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { attachAudioToVideo, generateMusic, generateSpeech, mixAudioTracks } from "./lib/audio-gen";
import { generateImage } from "./lib/image-gen";
import { detectMimeType, ensureCorrectExtension } from "./lib/mime-detect";
import { listAudioProviders } from "./lib/providers/audio-registry";
import { listProviders } from "./lib/providers/registry";
import { renderVideo } from "./lib/renderer";
import { stitchClips } from "./lib/stitch";
import { generateVideoClip } from "./lib/video-gen";
import { analyzeVideoWithVision, extractFrames, prepareVideoReference } from "./lib/video-ref";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ASSET_DIR = "/tmp/video-gen/assets";
const DEFAULT_CLIP_DIR = "/tmp/video-gen/clips";
const DEFAULT_AUDIO_DIR = "/tmp/video-gen/audio";
const REMOTION_TEMPLATE_DIR = resolve(dirname(import.meta.path), "remotion-template");

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
	name: "video",
	version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: generate_asset
// ---------------------------------------------------------------------------

server.tool(
	"generate_asset",
	"Generate a still image from a text prompt using Gemini 3.1 Flash Image via OpenRouter",
	{
		prompt: z.string().describe("Text description of the image to generate"),
		filename: z.string().describe("Output filename (e.g. scene1.png)"),
		output_dir: z
			.string()
			.optional()
			.describe(`Directory to save the image (default: ${DEFAULT_ASSET_DIR})`),
		style_prefix: z
			.string()
			.optional()
			.describe("Style modifier prepended to the prompt (e.g. 'Cinematic, 35mm film grain')"),
	},
	async ({ prompt, filename, output_dir, style_prefix }) => {
		try {
			const dir = output_dir ?? DEFAULT_ASSET_DIR;
			await ensureDir(dir);

			const result = await generateImage(prompt, {
				style: style_prefix,
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
// Tool: generate_clip
// ---------------------------------------------------------------------------

server.tool(
	"generate_clip",
	"Generate a video clip from text or reference image using Veo (or another configured provider)",
	{
		prompt: z.string().describe("Text description of the motion/action for the clip"),
		duration: z
			.union([z.literal(4), z.literal(6), z.literal(8)])
			.optional()
			.describe("Clip duration in seconds (4, 6, or 8)"),
		aspect_ratio: z.string().optional().describe("Aspect ratio (e.g. '16:9' or '9:16')"),
		reference_image_path: z
			.string()
			.optional()
			.describe("Path to a reference image (used as first frame for image-to-video)"),
		output_dir: z
			.string()
			.optional()
			.describe(`Directory to save the clip (default: ${DEFAULT_CLIP_DIR})`),
		filename: z.string().optional().describe("Output filename (default: auto-generated UUID)"),
		provider: z
			.string()
			.optional()
			.describe("Video provider name (e.g. 'veo'). Uses first configured provider if omitted"),
	},
	async ({
		prompt,
		duration,
		aspect_ratio,
		reference_image_path,
		output_dir,
		filename,
		provider,
	}) => {
		try {
			const dir = output_dir ?? DEFAULT_CLIP_DIR;
			await ensureDir(dir);

			// Read reference image if provided
			let referenceImage: Buffer | undefined;
			let referenceImageMimeType: string | undefined;
			if (reference_image_path) {
				const file = Bun.file(reference_image_path);
				if (!(await file.exists())) {
					return err(`Reference image not found: ${reference_image_path}`);
				}
				const arrayBuf = await file.arrayBuffer();
				referenceImage = Buffer.from(arrayBuf);
				const detected = detectMimeType(referenceImage);
				referenceImageMimeType = detected.mimeType;
			}

			const result = await generateVideoClip(prompt, {
				duration: duration as 4 | 6 | 8 | undefined,
				aspectRatio: aspect_ratio as "16:9" | "9:16" | undefined,
				referenceImage,
				referenceImageMimeType,
				provider,
			});

			const outFilename = filename ?? `clip-${crypto.randomUUID()}.mp4`;
			const outPath = join(dir, outFilename);
			await Bun.write(outPath, result.buffer);

			const stat = Bun.file(outPath);
			return ok({
				path: outPath,
				mimeType: result.mimeType,
				model: result.model,
				sizeBytes: stat.size,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: stitch_clips
// ---------------------------------------------------------------------------

server.tool(
	"stitch_clips",
	"Concatenate video clips into a single video using ffmpeg",
	{
		clip_paths: z
			.array(z.string())
			.min(2)
			.describe("Ordered list of clip file paths to concatenate"),
		output_path: z.string().describe("Path for the output video file"),
		transition: z
			.enum(["none", "crossfade"])
			.optional()
			.describe("Transition mode (default: 'none')"),
		transition_duration: z
			.number()
			.optional()
			.describe(
				"Crossfade duration in seconds (default: 1). Only used when transition is 'crossfade'",
			),
	},
	async ({ clip_paths, output_path, transition, transition_duration }) => {
		try {
			const resultPath = await stitchClips(clip_paths, output_path, {
				transition: transition as "none" | "crossfade" | undefined,
				transitionDuration: transition_duration,
			});

			const stat = Bun.file(resultPath);
			return ok({
				path: resultPath,
				sizeBytes: stat.size,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: compose_video
// ---------------------------------------------------------------------------

server.tool(
	"compose_video",
	"Compose a rich video with overlays, transitions, and text using Remotion",
	{
		script: z
			.string()
			.describe("JSON video script (will be parsed and passed as Remotion input props)"),
		output_path: z.string().describe("Path for the output video file"),
		template: z.string().optional().describe("Remotion composition ID (default: 'ScriptedVideo')"),
		project_dir: z
			.string()
			.optional()
			.describe(
				"Path to an existing Remotion project. If omitted, copies remotion-template to a temp dir",
			),
	},
	async ({ script, output_path, template, project_dir }) => {
		try {
			// Parse the script JSON
			let scriptObj: Record<string, unknown>;
			try {
				scriptObj = JSON.parse(script);
			} catch {
				return err("Invalid JSON in 'script' parameter. Must be a valid JSON string.");
			}

			const compositionId = template ?? "ScriptedVideo";

			// Determine project directory
			let projectDir = project_dir;
			if (!projectDir) {
				// Copy remotion-template to a temp directory
				const tempDir = join("/tmp", `remotion-project-${crypto.randomUUID()}`);
				await Bun.$`cp -r ${REMOTION_TEMPLATE_DIR} ${tempDir}`;
				await Bun.$`bun install`.cwd(tempDir);
				projectDir = tempDir;
			}

			const resultPath = await renderVideo(
				projectDir,
				compositionId,
				{ script: scriptObj },
				output_path,
			);

			const stat = Bun.file(resultPath);
			return ok({
				path: resultPath,
				sizeBytes: stat.size,
				compositionId,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: scaffold_project
// ---------------------------------------------------------------------------

server.tool(
	"scaffold_project",
	"Create a new Remotion project from the template",
	{
		project_name: z.string().describe("Name for the new project directory"),
		output_dir: z
			.string()
			.optional()
			.describe("Parent directory for the project (default: current working directory)"),
	},
	async ({ project_name, output_dir }) => {
		try {
			const parentDir = output_dir ?? process.cwd();
			const projectPath = join(parentDir, project_name);

			// Check if target already exists
			if (await Bun.file(join(projectPath, "package.json")).exists()) {
				return err(`Project already exists at ${projectPath}`);
			}

			// Copy template
			await Bun.$`cp -r ${REMOTION_TEMPLATE_DIR} ${projectPath}`;

			// Install dependencies
			await Bun.$`bun install`.cwd(projectPath);

			return ok({
				path: projectPath,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: generate_speech
// ---------------------------------------------------------------------------

server.tool(
	"generate_speech",
	"Generate speech audio from text using a TTS provider (ElevenLabs, OpenRouter, etc.)",
	{
		text: z.string().describe("The text to convert to speech"),
		voice: z.string().optional().describe("Voice ID or name (provider-specific)"),
		model: z.string().optional().describe("Override the default model"),
		provider: z
			.string()
			.optional()
			.describe("Audio provider name. Uses first configured provider if omitted"),
		speed: z.number().optional().describe("Speaking speed multiplier (1.0 = normal)"),
		format: z.enum(["mp3", "wav"]).optional().describe("Output audio format (default: mp3)"),
		output_dir: z
			.string()
			.optional()
			.describe(`Directory to save the audio (default: ${DEFAULT_AUDIO_DIR})`),
		filename: z.string().optional().describe("Output filename (default: auto-generated UUID)"),
	},
	async ({ text, voice, model, provider, speed, format, output_dir, filename }) => {
		try {
			const dir = output_dir ?? DEFAULT_AUDIO_DIR;
			await ensureDir(dir);

			const result = await generateSpeech(text, {
				voice,
				model,
				provider,
				speed,
				format: format as "mp3" | "wav" | undefined,
			});

			const ext = format ?? "mp3";
			const outFilename = filename ?? `speech-${crypto.randomUUID()}.${ext}`;
			const outPath = join(dir, outFilename);
			await Bun.write(outPath, result.buffer);

			const stat = Bun.file(outPath);
			return ok({
				path: outPath,
				mimeType: result.mimeType,
				sizeBytes: stat.size,
				duration: result.duration,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: generate_music
// ---------------------------------------------------------------------------

server.tool(
	"generate_music",
	"Generate music from a text prompt using an audio provider",
	{
		prompt: z.string().describe("Text description of the music to generate"),
		duration: z.number().optional().describe("Duration in seconds"),
		genre: z.string().optional().describe("Genre hint (e.g. 'cinematic', 'electronic')"),
		mood: z.string().optional().describe("Mood hint (e.g. 'epic', 'melancholy', 'upbeat')"),
		provider: z
			.string()
			.optional()
			.describe("Audio provider name. Uses first configured provider if omitted"),
		output_dir: z
			.string()
			.optional()
			.describe(`Directory to save the audio (default: ${DEFAULT_AUDIO_DIR})`),
		filename: z.string().optional().describe("Output filename (default: auto-generated UUID)"),
	},
	async ({ prompt, duration, genre, mood, provider, output_dir, filename }) => {
		try {
			const dir = output_dir ?? DEFAULT_AUDIO_DIR;
			await ensureDir(dir);

			const result = await generateMusic(prompt, {
				duration,
				genre,
				mood,
				provider,
			});

			const outFilename = filename ?? `music-${crypto.randomUUID()}.mp3`;
			const outPath = join(dir, outFilename);
			await Bun.write(outPath, result.buffer);

			const stat = Bun.file(outPath);
			return ok({
				path: outPath,
				mimeType: result.mimeType,
				sizeBytes: stat.size,
				duration: result.duration,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: mix_audio
// ---------------------------------------------------------------------------

server.tool(
	"mix_audio",
	"Mix multiple audio tracks into one using ffmpeg",
	{
		tracks: z
			.array(
				z.object({
					path: z.string().describe("Path to an audio file"),
					volume: z
						.number()
						.optional()
						.describe("Volume multiplier (0.0 to 1.0+). Defaults to 1.0"),
					delay: z
						.number()
						.optional()
						.describe("Delay before this track starts, in seconds. Defaults to 0"),
				}),
			)
			.min(1)
			.describe("Audio tracks to mix"),
		output_path: z.string().describe("Path for the output audio file"),
	},
	async ({ tracks, output_path }) => {
		try {
			const resultPath = await mixAudioTracks(tracks, output_path);
			const stat = Bun.file(resultPath);
			return ok({
				path: resultPath,
				sizeBytes: stat.size,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: attach_audio
// ---------------------------------------------------------------------------

server.tool(
	"attach_audio",
	"Attach an audio track to a video file using ffmpeg",
	{
		video_path: z.string().describe("Path to the input video file"),
		audio_path: z.string().describe("Path to the input audio file"),
		output_path: z.string().describe("Path for the output video file"),
		replace: z
			.boolean()
			.optional()
			.describe("If true, replaces existing audio. If false (default), adds as additional track"),
	},
	async ({ video_path, audio_path, output_path, replace }) => {
		try {
			const resultPath = await attachAudioToVideo(video_path, audio_path, output_path, {
				replace,
			});
			const stat = Bun.file(resultPath);
			return ok({
				path: resultPath,
				sizeBytes: stat.size,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: list_audio_providers
// ---------------------------------------------------------------------------

server.tool(
	"list_audio_providers",
	"List available audio generation providers and their configuration status",
	{},
	async () => {
		try {
			const providers = listAudioProviders();
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
// Tool: extract_frames
// ---------------------------------------------------------------------------

server.tool(
	"extract_frames",
	"Extract key frames from a video file using ffmpeg",
	{
		video_path: z.string().describe("Path to the input video file"),
		count: z
			.number()
			.optional()
			.describe("Number of frames to extract (default: 5). Ignored if interval_seconds is set"),
		interval_seconds: z
			.number()
			.optional()
			.describe("Extract a frame every N seconds (overrides count)"),
		format: z.enum(["png", "jpg"]).optional().describe("Output image format (default: png)"),
		output_dir: z
			.string()
			.optional()
			.describe("Directory for extracted frames (default: /tmp/video-gen/frames)"),
	},
	async ({ video_path, count, interval_seconds, format, output_dir }) => {
		try {
			const frames = await extractFrames(video_path, {
				count,
				intervalSeconds: interval_seconds,
				format: format as "png" | "jpg" | undefined,
				outputDir: output_dir,
			});

			return ok({
				frames: frames.map((f) => ({
					path: f.path,
					timestamp: f.timestamp,
					mimeType: f.mimeType,
				})),
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: analyze_video
// ---------------------------------------------------------------------------

server.tool(
	"analyze_video",
	"Analyze a video with a vision model to get a structured description of its content",
	{
		video_path: z.string().describe("Path to the input video file"),
		prompt: z.string().describe("Describe what you want to understand about the video"),
		frame_count: z
			.number()
			.optional()
			.describe("Number of frames to extract for analysis (default: 4)"),
		model: z
			.string()
			.optional()
			.describe("Vision model to use via OpenRouter (default: google/gemini-2.5-flash-preview)"),
	},
	async ({ video_path, prompt, frame_count, model }) => {
		try {
			const analysis = await analyzeVideoWithVision(video_path, prompt, {
				frameCount: frame_count,
				model,
			});

			return ok({ analysis });
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: prepare_reference
// ---------------------------------------------------------------------------

server.tool(
	"prepare_reference",
	"Prepare a video clip as generation input: extract frames, analyze with vision, and build an enriched prompt",
	{
		video_path: z.string().describe("Path to the source video file"),
		changes: z
			.string()
			.describe(
				"Describe what to change about the video (e.g. 'make the sky purple and add rain')",
			),
		extraction_count: z.number().optional().describe("Number of frames to extract (default: 4)"),
		analysis_model: z
			.string()
			.optional()
			.describe("Vision model for analysis (default: google/gemini-2.5-flash-preview)"),
		target_provider: z
			.string()
			.optional()
			.describe("Target video generation provider (for capability checking)"),
	},
	async ({ video_path, changes, extraction_count, analysis_model, target_provider }) => {
		try {
			const result = await prepareVideoReference(video_path, changes, {
				extractionCount: extraction_count,
				analysisModel: analysis_model,
				targetProvider: target_provider,
			});

			return ok({
				referenceImages: result.referenceImages,
				enrichedPrompt: result.enrichedPrompt,
				originalAnalysis: result.originalAnalysis,
			});
		} catch (error) {
			return err(error instanceof Error ? error.message : String(error));
		}
	},
);

// ---------------------------------------------------------------------------
// Tool: list_providers
// ---------------------------------------------------------------------------

server.tool(
	"list_providers",
	"List available video generation providers and their configuration status",
	{},
	async () => {
		try {
			const providers = listProviders();
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
	physical: CharacterPhysicalSchema.deepPartial().optional()
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
		physical: CharacterPhysicalSchema.describe("Structured physical attributes — the Character Identity Descriptor (CID)"),
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
	async ({ name, physical, style_anchor, negative_prompts, additional_details, generate_reference, provider, model }) => {
		try {
			// 1. Guard: reject duplicate names
			if (await characterExists(name)) {
				return err(`Character "${name}" already exists. Use update_character to modify, or choose a different name.`);
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
				const { analyzeImage } = await import("@randal/image-gen-tool");
				const refPrompt = buildReferencePrompt(profile);
				const result = await generateImage(refPrompt, {
					model,
					provider,
				});

				// Save reference image to character directory
				const charDir = getCharacterDir();
				await ensureCharacterDir();
				const detected = detectMimeType(result.buffer);
				const refFilename = ensureCorrectExtension(`${name}_reference.png`, detected.mimeType);
				const refPath = join(charDir, refFilename);
				await Bun.write(refPath, result.buffer);

				// 5. Analyze the reference to see what the model actually rendered
				const analysis = await analyzeImage(refPath, [
					"Describe this person's physical appearance in detail.",
					"Focus on: face shape, jawline, chin, cheekbones, eye color/shape, nose, brows, mouth/lips,",
					"skin tone, hair color/length/style/texture, build, apparent age, any distinguishing marks.",
					"Be precise and specific — this will be used to reproduce this exact person in future images.",
				].join(" "));

				// 6. Update profile with reference path and analysis
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
		character_name: z.string().min(1).describe("Name of an existing character (as passed to create_character)"),
		prompt: z.string().min(1).describe("Scene/action description — the character's identity is prepended automatically"),
		overrides: CharacterPhysicalOverrideSchema
			.optional()
			.describe("Temporary physical attribute overrides for this generation only (e.g., different hairstyle). Does NOT modify the saved profile."),
		verify_consistency: z
			.boolean()
			.optional()
			.default(true)
			.describe("Analyze the output against the CID and retry if consistency score < min_score (default: true)"),
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
			.describe(`Directory to save the image (default: ${DEFAULT_ASSET_DIR})`),
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
			const effectiveProfile = style_prefix
				? { ...profile, style_anchor: style_prefix }
				: profile;

			// 3. Build the composite prompt (CID + scene + style + negatives)
			const compositePrompt = buildCharacterPrompt(
				effectiveProfile,
				prompt,
				overrides as Partial<CharacterPhysical> | undefined,
			);

			// 4. Set up output path
			const dir = output_dir ?? DEFAULT_ASSET_DIR;
			await ensureDir(dir);
			const outFilename = filename ?? `${character_name}-${crypto.randomUUID().slice(0, 8)}.png`;

			// 5. Define the generate-and-save function for the consistency wrapper
			const generateFn = async (currentPrompt: string): Promise<{ imagePath: string }> => {
				const result = await generateImage(currentPrompt, {
					model,
					provider,
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
