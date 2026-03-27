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

## Character Consistency

Maintain the same character's appearance across multiple image generations using structured Character Identity Descriptors (CIDs).

### How It Works

1. **Define**: Create a character with structured physical attributes (face, hair, eyes, build, etc.)
2. **Reference**: A reference headshot is auto-generated and analyzed to anchor the character's appearance
3. **Generate**: Use `generate_with_character` for any scene — the CID is automatically prepended to every prompt
4. **Verify**: Built-in consistency scoring compares each output against the CID, retrying if the result drifts
5. **Iterate**: Refine the character over time with `update_character`

### Character Tools

#### `create_character`
Create a new persistent character with structured physical descriptors.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Unique character name (e.g. `elena-vargas`) |
| `physical` | Yes | Structured CID — see Physical Fields table below |
| `style_anchor` | No | Default style (default: "Cinematic portrait, natural lighting, photorealistic") |
| `negative_prompts` | No | Elements to avoid (default: cartoon, anime, deformed, etc.) |
| `additional_details` | No | Extra free-text context for every generation |
| `generate_reference` | No | Auto-generate reference headshot (default: true) |
| `provider` | No | Image provider override |
| `model` | No | Image model override |

**Returns:** Full `CharacterProfile` JSON including `reference_image_path`.

#### `generate_with_character`
Generate an image of a saved character in a specific scene.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `character_name` | Yes | Name of existing character |
| `prompt` | Yes | Scene description (CID auto-prepended) |
| `overrides` | No | Temporary physical overrides (e.g. different hairstyle) |
| `verify_consistency` | No | Auto-verify and retry (default: true) |
| `max_retries` | No | Max retries on low score (default: 2, max: 5) |
| `min_score` | No | Minimum consistency score 1-10 (default: 7) |
| `output_dir` | No | Output directory |
| `filename` | No | Output filename |
| `style_prefix` | No | Override style_anchor for this generation |
| `provider` | No | Image provider override |
| `model` | No | Image model override |

**Returns:** `{ image_path, character_name, consistency_score, retries_used }`

#### `list_characters`
List all saved characters. No parameters.

**Returns:** Array of `{ name, created_at, updated_at, reference_image_path, style_anchor }`

#### `get_character`
Get the full profile for a character.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Character name |

**Returns:** Full `CharacterProfile` JSON.

#### `update_character`
Update a saved character's fields (deep-merges physical attributes).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Character name to update |
| `updates` | Yes | Object with fields to update (physical, style_anchor, negative_prompts, additional_details) |

**Returns:** Updated `CharacterProfile`.

### Physical Fields Reference (CID)

The `physical` parameter accepts a structured object with these fields:

| Field | Required | Example |
|-------|----------|---------|
| `age` | Yes | "mid-30s" |
| `gender` | Yes | "female" |
| `ethnicity` | Yes | "East Asian" |
| `skin_tone` | Yes | "warm olive" |
| `build` | Yes | "athletic, lean" |
| `height` | Yes | "tall, ~5'10\"" |
| `face_shape` | Yes | "oval with high cheekbones" |
| `jawline` | Yes | "soft, slightly angular" |
| `chin` | Yes | "rounded, slight cleft" |
| `cheekbones` | Yes | "prominent, high-set" |
| `eyes` | Yes | `{ color, shape, spacing, details }` |
| `nose` | Yes | "straight bridge, slightly rounded tip" |
| `brows` | Yes | "naturally thick, gently arched" |
| `mouth` | Yes | "full lips, defined cupid's bow" |
| `hair` | Yes | `{ color, length, style, texture, part }` |
| `facial_hair` | No | "trimmed goatee" |
| `skin_details` | No | "light freckles across nose" |
| `distinguishing_marks` | No | "small mole above right lip" |

**`eyes` sub-fields:** `color`, `shape`, `spacing`, `details` (all required strings)

**`hair` sub-fields:** `color`, `length`, `style`, `texture`, `part` (all required strings)

### Workflow Example

```
Step 1: Create the character
-> create_character(
     name: "elena-vargas",
     physical: {
       age: "early 30s", gender: "female", ethnicity: "Latina",
       skin_tone: "warm brown", build: "athletic", height: "5'7\"",
       face_shape: "heart-shaped", jawline: "soft, tapered",
       chin: "slightly pointed", cheekbones: "high, defined",
       eyes: { color: "dark brown", shape: "large, almond",
               spacing: "average", details: "long lashes" },
       nose: "straight, slightly upturned tip",
       brows: "thick, naturally arched",
       mouth: "full lips, wide smile",
       hair: { color: "dark brown with auburn highlights",
               length: "shoulder-length", style: "loose waves",
               texture: "thick, slightly coarse", part: "side part" },
       distinguishing_marks: "small beauty mark on left cheek"
     }
   )

Step 2: Generate consistent images
-> generate_with_character(
     character_name: "elena-vargas",
     prompt: "standing in a busy coffee shop, ordering at the counter, morning light"
   )
-> generate_with_character(
     character_name: "elena-vargas",
     prompt: "jogging in a park at sunset, wearing running gear, determined expression"
   )
-> generate_with_character(
     character_name: "elena-vargas",
     prompt: "at a formal dinner, elegant black dress, candlelit restaurant",
     overrides: { hair: { style: "updo, elegant bun" } }
   )

Step 3: Refine if needed
-> get_character(name: "elena-vargas")
-> update_character(
     name: "elena-vargas",
     updates: { physical: { hair: { color: "dark brown, no highlights" } } }
   )
```

### Tips for Best Consistency

- **Be specific in CID fields**: "dark brown, almost black" beats "brown". More specific descriptors give the model less room to drift.
- **Use overrides for temporary changes**: Outfit, expression, or hair styling changes should use `overrides`. Permanent changes should use `update_character`.
- **Start with `verify_consistency=true`**: The initial generations help calibrate. Once you're confident the model handles your character well, disable verification to save time and API calls.
- **Style anchors matter**: A consistent style anchor (e.g., "cinematic photography, shallow depth of field") helps more than you'd expect for cross-scene consistency.
- **Distinguishing marks are powerful anchors**: A mole, scar, or unique feature gives the model a strong visual anchor that improves consistency.
- **Check the reference image**: If the auto-generated reference doesn't match your intent, create a new character with refined descriptors rather than trying to fix it via updates.

### Character Error Codes

| Error Code | Meaning | Action |
|-----------|---------|--------|
| `NOT_FOUND` | Character doesn't exist | Check the name with `list_characters` |
| `ALREADY_EXISTS` | Name is taken | Use a different name or `update_character` |
| `INVALID_PROFILE` | Corrupted profile JSON | Delete and recreate the character |
| `STORAGE_ERROR` | Filesystem error | Check permissions on `~/.config/randal/characters/` |
| `CONSISTENCY_ERROR` | Consistency check failed | Usually transient — retry or lower `min_score` |
