# Image Generation & Analysis Skill

## Overview

The image-gen tool provides two core capabilities:
1. **Image Generation** — Create images from text prompts using AI models (default: Gemini Flash via OpenRouter, a.k.a. "NanoBanana")
2. **Image Analysis** — Understand and describe existing images using multimodal vision models

This tool is a standalone primitive that can be used in any workflow — video production, content creation, design iteration, visual QA, etc.

## Available Tools

### `generate_image`
Generate a still image from a text prompt and save to disk.

**Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | ✅ | Text description of the image to generate |
| `filename` | ✅ | Output filename (e.g. `hero-banner.png`) |
| `output_dir` | ❌ | Directory to save (default: `/tmp/image-gen/output`) |
| `style_prefix` | ❌ | Style modifier (e.g. "Cinematic, 35mm film grain") |
| `model` | ❌ | Override default model |
| `provider` | ❌ | Select specific provider |

**Returns:** `{ path, mimeType, sizeBytes, requestedFilename, actualFilename }`

Note: The tool auto-detects the actual image format from bytes and corrects the file extension. If you request `scene.png` but the model returns a JPEG, the file will be saved as `scene.jpg`.

**Examples:**
```
Generate a photorealistic sunset over the Pacific Ocean with sailboats
→ generate_image(prompt="...", filename="sunset.png", style_prefix="photorealistic, golden hour lighting")

Create a logo concept for a coffee shop called "Bean There"
→ generate_image(prompt="Minimalist logo for coffee shop called Bean There, clean lines, warm browns", filename="logo-concept.png")

Generate a UI mockup
→ generate_image(prompt="Modern dashboard UI with dark theme, showing analytics charts and user metrics", filename="dashboard-mockup.png")
```

### `analyze_image`
Analyze an existing image using a multimodal vision model.

**Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `image_path` | ✅ | Path to the image file |
| `prompt` | ✅ | What you want to understand about the image |
| `model` | ❌ | Vision model override (default: `google/gemini-2.5-flash-preview`) |

**Returns:** Structured analysis with `description`, `objects`, `text`, `colors`, `style`, `mood`

**Examples:**
```
Describe what's in this screenshot
→ analyze_image(image_path="/tmp/screenshot.png", prompt="Describe all UI elements and their layout")

Extract text from a photo
→ analyze_image(image_path="/tmp/whiteboard.jpg", prompt="Extract all text visible in this image")

Analyze visual style for reproduction
→ analyze_image(image_path="/tmp/reference.png", prompt="Describe the visual style, color palette, and composition in detail so I can reproduce it")
```

### `list_image_providers`
List registered image generation providers and their configuration status.

**Parameters:** none

**Returns:** Array of `{ name, description, models, configured }`

## Providers

### OpenRouter (default)
- **Provider name:** `openrouter`
- **Default model:** `google/gemini-3.1-flash-image-preview` ("NanoBanana")
- **Alt models:** `google/gemini-2.0-flash-exp:free`
- **Requires:** `OPENROUTER_API_KEY` environment variable

## Workflow Patterns

### Generate then Analyze (iteration loop)
1. Generate an image with a prompt
2. Analyze the result to check if it matches intent
3. Refine the prompt based on analysis
4. Regenerate — repeat until satisfied

### Analyze then Generate (reference-based)
1. Analyze a reference image to extract style/composition details
2. Use the analysis to craft a detailed generation prompt
3. Generate a new image with the extracted style guidance

### Visual QA
1. Generate UI screenshots or design mockups
2. Analyze them for accessibility, layout issues, or design consistency
3. Report findings

## Error Handling

| Error Code | Meaning | Action |
|-----------|---------|--------|
| `MISSING_API_KEY` | `OPENROUTER_API_KEY` not set | Set the environment variable |
| `CONTENT_POLICY` | Prompt blocked by safety filters | Revise the prompt |
| `RATE_LIMITED` | Too many requests | Wait and retry (auto-retry built in) |
| `NO_IMAGE_IN_RESPONSE` | Model returned text instead of image | Rephrase prompt to emphasize visual output |
| `MISSING_INPUT` | Image file not found for analysis | Check file path |

## Tips

- **Style prefixes** dramatically improve output quality. Use them for consistent visual style across multiple generations.
- **Be specific** in prompts: "A golden retriever puppy sitting on a red couch, soft window light, shallow depth of field" beats "a dog on a couch"
- **MIME auto-correction**: Don't worry about file extensions — the tool detects actual image format from bytes and corrects automatically.
- **Analysis prompts**: Be specific about what you want to know. "Describe everything" gives broad results; "List all text visible in the image" gives focused results.
