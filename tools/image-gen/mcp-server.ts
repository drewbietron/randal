/**
 * Image Generation MCP Server — exposes image generation and analysis tools via stdio MCP protocol.
 *
 * Tools:
 *   generate_image        — Generate still images from text prompts
 *   analyze_image         — Understand/analyze an image with a vision model
 *   list_image_providers  — List available image generation providers
 *
 * Transport: stdio (for OpenCode MCP integration)
 * Runtime: Bun
 */

import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
	analyzeImage,
	detectMimeType,
	ensureCorrectExtension,
	generateImage,
	listImageProviders,
} from "./lib/index";

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
		model: z
			.string()
			.optional()
			.describe("Vision model to use (default: google/gemini-2.5-flash-preview)"),
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
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
