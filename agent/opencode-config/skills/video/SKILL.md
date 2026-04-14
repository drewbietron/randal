---
name: video
description: Video production toolkit. Generate images, create video clips (text-to-video or image-to-video), stitch clips together, and compose rich videos with Remotion. The agent is the director — plan the story, then build scene by scene.
---

# Video Production

You are a video director. These tools give you the primitives — you provide the story, consistency, and creative direction.

## Tool Reference

| Tool | Args | Returns |
|------|------|---------|
| `video_generate_asset` | `prompt`, `filename`, `output_dir?`, `style_prefix?` | Image path + metadata (width, height, mimeType) |
| `video_generate_clip` | `prompt`, `duration?` (4/6/8s), `aspect_ratio?`, `reference_image_path?`, `filename?`, `provider?` | Clip path + metadata (mimeType, model, sizeBytes) |
| `video_stitch_clips` | `clip_paths` (JSON array), `output_path`, `transition?`, `transition_duration?` | Final video path + sizeBytes |
| `video_compose_video` | `script` (JSON), `output_path`, `template?`, `project_dir?` | Rendered video path + sizeBytes |
| `video_scaffold_project` | `project_name`, `output_dir?` | Project path + available compositionIds |
| `video_list_providers` | _(none)_ | Array of providers with name, models, configured status |

## Two Paths

**Simple path** (no Remotion needed):
`generate_asset` → `generate_clip` (with reference image) → `stitch_clips` → done

**Rich path** (overlays, transitions, text, audio):
`generate_asset` → `generate_clip` → `compose_video` (Remotion) → done

Use the simple path unless you need text overlays, transitions, or complex compositions.

## VideoScript Schema (compose_video)

The `compose_video` tool accepts a JSON string conforming to the `VideoScript` schema. This is the **canonical format** — do NOT invent alternatives (no `layers`, no `meta` block, no nested `type` within layers).

### Top-Level Fields

```typescript
{
  title?: string;        // Optional metadata title (not rendered)
  fps?: number;          // Frames per second (default: 30)
  width?: number;        // Canvas width in px (default: 1920)
  height?: number;       // Canvas height in px (default: 1080)
  scenes: Scene[];       // Ordered list of scenes (required, >= 1)
  globalAudio?: AudioTrack[];  // Audio spanning the entire video (narration, music)
}
```

### Scene

Each scene is a **flat object** with a `type` that determines its background:

```typescript
{
  type: "image" | "video" | "text" | "color";  // REQUIRED — scene background type
  src?: string;          // Path to image/video file (required for "image"/"video")
  text?: string;         // Text content (required for "text" type)
  color?: string;        // CSS color value (required for "color" type)
  duration: number;      // Scene duration in seconds (required, > 0)
  transition?: Transition;  // Transition INTO this scene (not applied to first scene)
  overlay?: TextOverlay;    // Single text overlay rendered on top
  audio?: AudioTrack;       // Per-scene audio track
}
```

### Transition

```typescript
{
  type: "crossfade" | "slide-left" | "slide-right" | "zoom-in" | "cut";
  duration: number;  // Duration in seconds (must be < scene duration)
}
```

### TextOverlay

```typescript
{
  text: string;                          // The text to display
  position?: "top" | "center" | "bottom";  // Vertical placement (default: "bottom")
  style?: "title" | "caption" | "subtitle"; // Visual preset (default: "caption")
}
```

### AudioTrack

```typescript
{
  src: string;            // Path to audio file
  volume?: number;        // Volume multiplier, 0.0-1.0+ (default: 1.0)
  startOffset?: number;   // Delay in seconds before playback (default: 0)
  fadeIn?: number;        // Fade in duration in seconds (default: 0)
  fadeOut?: number;       // Fade out duration in seconds (default: 0)
  loop?: boolean;         // Whether to loop (default: false)
}
```

### Asset Path Resolution

- **Absolute paths** (e.g. `/tmp/video-gen/assets/scene1.png`) are **automatically copied** into the Remotion project's `public/` directory by `compose_video`. The path in the script is rewritten to just the filename. You do NOT need to manually copy files or scaffold a project.
- **Relative paths** (e.g. `scene1.png`) are assumed to already exist in `public/`.
- For `generate_asset` and `generate_speech` outputs, just pass the full path from the tool's response — `compose_video` handles the rest.

### Complete Working Example

```json
{
  "title": "Product Demo",
  "fps": 30,
  "width": 1080,
  "height": 1920,
  "scenes": [
    {
      "type": "image",
      "src": "/tmp/video-gen/assets/intro.png",
      "duration": 5,
      "overlay": {
        "text": "Welcome to the future.",
        "position": "center",
        "style": "title"
      }
    },
    {
      "type": "image",
      "src": "/tmp/video-gen/assets/features.png",
      "duration": 5,
      "transition": { "type": "crossfade", "duration": 0.5 },
      "overlay": {
        "text": "Built for developers.",
        "position": "bottom",
        "style": "caption"
      }
    },
    {
      "type": "color",
      "color": "#000000",
      "duration": 5,
      "transition": { "type": "crossfade", "duration": 0.5 },
      "overlay": {
        "text": "Get started today.",
        "position": "center",
        "style": "title"
      }
    }
  ],
  "globalAudio": [
    {
      "src": "/tmp/video-gen/audio/voiceover.mp3",
      "volume": 1.0
    }
  ]
}
```

### Common Mistakes to Avoid

- ❌ **Do NOT** use a `layers` array inside scenes — each scene has ONE background (`type` + `src`/`text`/`color`) and ONE optional `overlay`
- ❌ **Do NOT** wrap the script in a `meta` + `scenes` structure — `fps`, `width`, `height` go at the top level alongside `scenes`
- ❌ **Do NOT** use `durationInFrames` — use `duration` in seconds (the composition converts to frames)
- ❌ **Do NOT** use custom CSS styles in overlays — use the `style` preset ("title", "caption", "subtitle")
- ❌ **Do NOT** use custom position objects — use the `position` preset ("top", "center", "bottom")
- ✅ **DO** pass absolute paths from `generate_asset`/`generate_speech` — they're auto-copied

## The Image-to-Video Workflow (Key Technique)

This is how you maintain visual consistency across scenes:

1. Generate a high-quality **reference image** for each scene using `video_generate_asset`
2. Pass that image as `reference_image_path` to `video_generate_clip` — Veo uses it as the first frame
3. The text prompt for the clip describes **MOTION**, not the scene (the image already defines the scene)

Example:
```
# Step 1: Generate reference image
video_generate_asset(
  prompt: "Cinematic, golden hour, wide shot of a mountain lake, pine trees, mist rising, 35mm film",
  filename: "scene1.png",
  style_prefix: "Cinematic, anamorphic lens, golden hour lighting, 35mm film grain"
)

# Step 2: Generate video clip from that image
video_generate_clip(
  prompt: "Slow camera push forward, mist gently swirling, water rippling",
  reference_image_path: "/tmp/video-gen/assets/scene1.png",
  duration: 8
)
```

## Maintaining Visual Consistency

- Define a **style prefix** at the start (e.g., "Cinematic, warm lighting, shallow DOF, 35mm film grain")
- Pass this as `style_prefix` to EVERY `video_generate_asset` call
- Write **character descriptions** once, reuse verbatim across all scenes
- Write **setting descriptions** once, reuse across scenes in the same location

## Planning a Video

When planning, include:
- **Story outline**: Beginning, middle, end
- **Scene breakdown**: Scene number, description, shot type, duration
- **Visual style guide**: The style prefix, color palette, lighting
- **Character sheet**: Describe each character once for reuse
- **Shot list**: Per scene — image prompt + motion prompt

## Building Scene by Scene

The build loop:
```
for each scene in the plan:
  1. video_generate_asset(scene.image_prompt, style_prefix=style_guide)
  2. video_generate_clip(scene.motion_prompt, reference_image_path=scene_image)
  3. collect the clip path
end

# Simple assembly (no overlays)
video_stitch_clips(all_clip_paths, output_path, transition="crossfade")

# Rich assembly (with text overlays, transitions, audio)
video_compose_video(script_json, output_path)
# Pass absolute paths in the script — compose_video auto-copies assets
```

## Long-Form Production (2+ hours)

- Break into acts/chapters (10-15 min each)
- Build each act as a separate batch of clips
- Stitch acts together at the end
- Budget: ~8s clips × ~900 clips = 2 hours. That's ~900 API calls.

## Provider Selection

- Default: "veo" (Google Veo)
- Use `video_list_providers` to see available providers
- Pass `provider: "name"` to `video_generate_clip` for alternatives
- New providers can be added by implementing the VideoProvider interface

## Prompt Engineering Tips

### For image generation (`video_generate_asset`)
Be specific about **static visual details**. The image is a photograph — describe what the camera sees.

| Instead of | Use |
|-----------|-----|
| "A beautiful sunset" | "Golden hour, low angle, sun touching the horizon line, silhouette of pine trees, warm orange and purple gradient sky, anamorphic lens flare" |
| "A man in an office" | "Medium shot, 40s businessman in navy suit, sitting at mahogany desk, warm tungsten desk lamp, venetian blinds casting horizontal shadows, shallow depth of field" |
| "A futuristic city" | "Wide establishing shot, cyberpunk cityscape, neon signs in Japanese and English, rain-wet streets reflecting purple and blue light, flying vehicles in mid-ground, towering glass skyscrapers, low camera angle" |

**Key elements to specify:** camera angle, focal length/lens type, lighting source and color, depth of field, composition (rule of thirds, leading lines), color palette, textures and materials.

### For video generation (`video_generate_clip`)
Be specific about **motion and change**. The reference image already defines the scene — your prompt drives what MOVES.

| Instead of | Use |
|-----------|-----|
| "A sunset scene" | "Sun slowly sinks below horizon, clouds drift left to right, light shifts from orange to deep purple" |
| "A man working" | "Man picks up phone, glances at it, puts it down, runs hand through hair, leans back in chair" |
| "City at night" | "Camera slowly tracks forward through street, neon signs flicker, rain drops streak across lens, a taxi passes left to right" |

**Key elements to specify:** camera movement (push in, pull out, pan, track, crane, static), character actions (specific gestures, not vibes), environmental motion (wind, water, particles, lights), timing (slow, sudden, gradual).

## Example Video Scripts

### 1. Product Showcase (30 seconds, 5 scenes)

```
Style prefix: "Product photography, clean white background, soft studio lighting, shallow depth of field, minimalist"

Scene 1 (6s): Wide shot of product on white surface
  Image: "[prefix]. Sleek wireless headphones on white marble surface, subtle shadow, single spotlight from upper right"
  Motion: "Slow 360-degree rotate, spotlight creates moving highlight across surface"

Scene 2 (6s): Detail shot of ear cup
  Image: "[prefix]. Extreme close-up of headphone ear cup, memory foam padding visible, brushed aluminum trim"
  Motion: "Slow push in, rack focus from outer rim to inner padding"

Scene 3 (6s): Someone putting them on
  Image: "[prefix]. Side profile of person reaching for headphones on desk, hand halfway to product"
  Motion: "Person picks up headphones and places them over ears, slight smile"

Scene 4 (6s): Lifestyle shot
  Image: "[prefix]. Person walking through city street wearing headphones, blurred urban background, golden hour"
  Motion: "Tracking shot following person walking, background bokeh lights shift"

Scene 5 (6s): Logo card
  → Use video_compose_video with TitleCard template, or video_generate_asset for a static card

Assembly: video_stitch_clips with crossfade transitions (0.5s each)
```

### 2. Explainer Video (2 minutes, 15 scenes)

```
Style prefix: "Flat illustration style, vibrant colors, clean lines, 2D animation aesthetic, pastel background"

Act 1 — The Problem (4 scenes, 30s)
  Scene 1 (8s): Title card with hook question
  Scene 2 (8s): Illustration of the problem (confused user at computer)
  Scene 3 (8s): Statistics/data visualization
  Scene 4 (6s): "There's a better way" transition

Act 2 — The Solution (6 scenes, 45s)
  Scene 5-10: Step-by-step walkthrough of the product/concept

Act 3 — The Payoff (5 scenes, 45s)
  Scene 11-14: Before/after comparison, testimonials
  Scene 15 (8s): CTA card

Assembly: video_compose_video with Explainer template for text overlays and section transitions
```

### 3. Social Media Post (3 scenes, 9:16 vertical)

```
Style prefix: "Bold, high contrast, saturated colors, clean typography space at top and bottom"

Scene 1 (4s): Hook shot — eye-catching visual
  Image: "[prefix]. Overhead shot of colorful smoothie bowl, 9:16 vertical, bright fruits arranged in pattern"
  Motion: "Slow zoom out revealing the full arrangement, slight rotation"
  aspect_ratio: "9:16"

Scene 2 (4s): Process shot
  Image: "[prefix]. Hands holding blender with colorful ingredients, kitchen counter, 9:16 vertical"
  Motion: "Blender starts, ingredients swirl, vibrant colors mix"
  aspect_ratio: "9:16"

Scene 3 (4s): Final reveal
  Image: "[prefix]. Finished smoothie in glass with straw, garnish, condensation on glass, 9:16 vertical"
  Motion: "Hand reaches in and picks up glass, slight tilt toward camera"
  aspect_ratio: "9:16"

Assembly: video_stitch_clips with crossfade (0.3s)
→ Add text overlay with video_compose_video if needed
```
