# Video Generation Tool

AI-powered video production primitives — generate images, create video clips, and assemble them into finished videos.

## Quick Start

```bash
# 1. Add API keys to the root .env file (if not already present)
#    OPENROUTER_API_KEY=sk-or-...
#    GOOGLE_AI_STUDIO_KEY=AI...
#    (See .env.example for all variables)

# 2. Verify ffmpeg is installed
ffmpeg -version
```

```ts
import { generateImage, generateVideoClip, stitchClips } from "./lib";

// Generate a reference image
const image = await generateImage(
  "Wide shot of a mountain range at sunset, golden light on snow-capped peaks",
  { style: "cinematic, warm tones, 35mm film grain" },
);
await Bun.write("/tmp/video-gen/scene1.png", image.buffer);

// Generate a clip from that image (image-to-video)
const clip1 = await generateVideoClip(
  "Camera slowly pushes in, clouds drifting across peaks",
  { referenceImage: image.buffer, duration: 8, aspectRatio: "16:9" },
);
await Bun.write("/tmp/video-gen/scene1.mp4", clip1.buffer);

// Generate a second clip
const clip2 = await generateVideoClip(
  "Wide pan across the valley, birds flying in formation",
  { referenceImage: image.buffer, duration: 6 },
);
await Bun.write("/tmp/video-gen/scene2.mp4", clip2.buffer);

// Stitch clips into a final video
const finalPath = await stitchClips(
  ["/tmp/video-gen/scene1.mp4", "/tmp/video-gen/scene2.mp4"],
  "/tmp/video-gen/final.mp4",
);
```

## Architecture

The agent is the **director**. These tools are **primitives** — the agent orchestrates them.

```
┌─────────────────────────────────────────────────────────────┐
│                   AGENT (Plan / Build Loop)                  │
│                                                             │
│  Plan: story outline, scene breakdown, style guide          │
│  Build: loop scene-by-scene, calling primitives             │
│                                                             │
│         ┌──────────────┐    ┌──────────────┐                │
│         │generate_asset│───▶│generate_clip │                │
│         │ (image gen)  │    │ (video gen)  │                │
│         └──────────────┘    └──────┬───────┘                │
│                                    │                        │
│                          ┌─────────▼─────────┐              │
│                          │   stitch_clips    │  Simple path │
│                          │    (ffmpeg)       │  (fast)      │
│                          └─────────┬─────────┘              │
│                                    │                        │
│                          ┌─────────▼─────────┐              │
│                          │  compose_video    │  Rich path   │
│                          │   (Remotion)      │  (optional)  │
│                          └─────────┬─────────┘              │
│                                    ▼                        │
│                              final.mp4                      │
└─────────────────────────────────────────────────────────────┘
```

### Two paths

| Path | Tools | Use when |
|------|-------|----------|
| **Simple** | `generate_asset` → `generate_clip` → `stitch_clips` | Quick clips, no text overlays needed. Fast, ffmpeg only. |
| **Rich** | `generate_asset` → `generate_clip` → `compose_video` | Need transitions, text overlays, music, timed animations. Requires Remotion + Node.js. |

## Tools Reference

### `generate_asset`

Generate a still image from a text prompt (Gemini 3.1 Flash via OpenRouter).

| Arg | Type | Description |
|-----|------|-------------|
| `prompt` | string | Text description of the image |
| `filename` | string | Output filename (e.g. `scene1.png`) |
| `output_dir` | string? | Output directory (default: `/tmp/video-gen/assets`) |
| `style_prefix` | string? | Style string prepended to prompt for consistency |

### `generate_clip`

Generate a 4-8 second video clip from text, optionally from a reference image.

| Arg | Type | Description |
|-----|------|-------------|
| `prompt` | string | Text description of the motion/action |
| `duration` | 4 \| 6 \| 8 | Clip duration in seconds (default: 8) |
| `aspect_ratio` | string? | `"16:9"` or `"9:16"` (default: `"16:9"`) |
| `reference_image_path` | string? | Path to image file — becomes the first frame |
| `filename` | string? | Output filename |
| `provider` | string? | Video provider name (default: first configured) |

### `stitch_clips`

Concatenate video clips using ffmpeg.

| Arg | Type | Description |
|-----|------|-------------|
| `clip_paths` | string | JSON array of file paths |
| `output_path` | string | Output video path |
| `transition` | string? | `"none"` (default) or `"crossfade"` |
| `transition_duration` | number? | Crossfade duration in seconds (default: 1) |

### `compose_video`

Rich video composition via Remotion (overlays, transitions, text, music).

| Arg | Type | Description |
|-----|------|-------------|
| `script` | string | JSON video script (see VideoScript schema) |
| `output_path` | string | Output video path |
| `template` | string? | Composition ID (default: `ScriptedVideo`) |
| `project_dir` | string? | Remotion project path (auto-copies template if omitted) |

### `scaffold_project`

Create a new Remotion project from the built-in template.

| Arg | Type | Description |
|-----|------|-------------|
| `project_name` | string | Directory name for the project |
| `output_dir` | string? | Parent directory (default: `/tmp/video-gen/projects`) |

### `list_providers`

List registered video generation providers and their config status. No arguments.

## Provider System

Providers implement the `VideoProvider` interface and are registered in a global registry.

### The `VideoProvider` interface

```ts
interface VideoProvider {
  readonly name: string;
  readonly description: string;
  readonly models: string[];

  generateClip(prompt: string, options?: GenerateClipOptions): Promise<GenerateClipResult>;
  isConfigured(): boolean;
}
```

### Built-in providers

| Provider | Models | API Key Env Var |
|----------|--------|-----------------|
| `veo` | `veo-3.0-generate-001`, `veo-3.1-generate-preview` | `GOOGLE_AI_STUDIO_KEY` |
| `mock` | `mock-v1` | _(none — always configured)_ |

### Adding a new provider

1. Create `tools/video/lib/providers/seeddance.ts`:

```ts
import type { VideoProvider, GenerateClipOptions, GenerateClipResult } from "./types";
import { VideoProviderError } from "./types";

export class SeedDanceProvider implements VideoProvider {
  readonly name = "seeddance";
  readonly description = "SeedDance video generation";
  readonly models = ["seeddance-v1"];

  isConfigured(): boolean {
    return Boolean(process.env.SEEDDANCE_API_KEY?.trim());
  }

  async generateClip(
    prompt: string,
    options?: GenerateClipOptions,
  ): Promise<GenerateClipResult> {
    const apiKey = process.env.SEEDDANCE_API_KEY;
    if (!apiKey?.trim()) {
      throw new VideoProviderError(
        "SEEDDANCE_API_KEY is not set",
        "MISSING_API_KEY",
        this.name,
      );
    }

    // ... call SeedDance API, return { buffer, mimeType, model, prompt }
  }
}
```

2. Register it in `tools/video/lib/providers/registry.ts`:

```ts
import { SeedDanceProvider } from "./seeddance";
registerProvider(new SeedDanceProvider());
```

3. Export from `tools/video/lib/providers/index.ts`.

The provider is now available via `generate_clip(prompt, { provider: "seeddance" })`.

## Setup

### Required

| Dependency | Purpose | Install |
|-----------|---------|---------|
| `OPENROUTER_API_KEY` | Image generation (Gemini 3.1 Flash) | [openrouter.ai](https://openrouter.ai) |
| `GOOGLE_AI_STUDIO_KEY` | Video generation (Veo) | [aistudio.google.com](https://aistudio.google.com) |
| `ffmpeg` | Clip stitching | `brew install ffmpeg` |
| Bun | Runtime | [bun.sh](https://bun.sh) |

### Optional

| Dependency | Purpose | Install |
|-----------|---------|---------|
| Node.js + npm | Remotion compositions | Required only for `compose_video` / `scaffold_project` |
| Remotion | Rich video composition | Installed per-project via `scaffold_project` |

### Environment variables

API keys are stored in the **root `.env` file** and referenced in `opencode.json` via `{env:VAR}` substitution. When running tools directly (outside OpenCode), ensure the vars are in your environment:

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENROUTER_API_KEY` | Image generation (Gemini 3.1 Flash via OpenRouter) | Yes |
| `GOOGLE_AI_STUDIO_KEY` | Video generation (Veo) | Yes |
| `VIDEO_OUTPUT_DIR` | Default output directory (default: `/tmp/video-gen/`) | No |

## File Structure

```
tools/video/
├── package.json
├── README.md
├── .gitignore
├── lib/
│   ├── index.ts                  # Barrel export
│   ├── image-gen.ts              # Image generation (OpenRouter / Gemini)
│   ├── video-gen.ts              # Video generation public API
│   ├── stitch.ts                 # ffmpeg concat / crossfade
│   ├── renderer.ts               # Remotion rendering (npx remotion render)
│   ├── providers/
│   │   ├── index.ts              # Provider barrel export
│   │   ├── types.ts              # VideoProvider interface, shared types
│   │   ├── registry.ts           # Provider registry (register, get, list)
│   │   ├── veo.ts                # Google Veo provider
│   │   └── mock.ts               # Mock provider (testing)
│   └── __tests__/
│       ├── image-gen.test.ts     # Image gen tests (15 tests)
│       ├── video-gen.test.ts     # Provider registry + video gen tests (12 tests)
│       ├── stitch.test.ts        # Stitch input validation tests (8 tests)
│       └── pipeline.test.ts      # End-to-end pipeline tests (14 tests)
└── remotion-template/
    ├── package.json
    ├── tsconfig.json
    ├── remotion.config.ts
    ├── tailwind.config.ts
    ├── public/
    └── src/
        ├── index.ts
        ├── Root.tsx
        ├── lib/
        │   ├── types.ts          # VideoScript, Scene types
        │   └── transitions.ts    # Transition helpers
        └── compositions/
            ├── ScriptedVideo.tsx  # Generic scene-by-scene
            ├── Slideshow.tsx      # Image sequence with transitions
            ├── TitleCard.tsx      # Animated text title
            ├── SocialPost.tsx     # Short-form vertical (9:16)
            └── Explainer.tsx      # Long-form with sections
```

## Testing

```bash
# Run all video tool tests
bun test tools/video/

# Run a specific test file
bun test tools/video/lib/__tests__/pipeline.test.ts
```

Tests use the mock provider and mocked `fetch` — no API keys or ffmpeg required.

| Test file | Tests | What it covers |
|-----------|-------|---------------|
| `image-gen.test.ts` | 15 | API key validation, request formatting, response parsing, error handling |
| `video-gen.test.ts` | 12 | Provider registry, mock provider, veo missing key |
| `stitch.test.ts` | 8 | Input validation, missing files, defaults |
| `pipeline.test.ts` | 14 | End-to-end flow, provider integration, reference image handling, error propagation |

## For OpenCode Users

The tools are also available as OpenCode custom tools at:

```
~/.config/opencode/tools/video.ts
```

These expose the same primitives (`generate_asset`, `generate_clip`, `stitch_clips`, `compose_video`, `scaffold_project`, `list_providers`) as callable tools within OpenCode. The skill file at `tools/skills/video.md` teaches the agent the full video director workflow.
