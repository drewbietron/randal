---
name: video
description: Video production toolkit. Use these tools to generate images, create video clips (text-to-video or image-to-video), stitch clips together, and compose rich videos with Remotion. The agent is the director — plan the story, then build scene by scene.
---

# Video Production Tools

You are a video director. You have six tools that handle generation and assembly — your job is to plan the story, define the visual style, and orchestrate scene-by-scene production.

## Tool Reference

| Tool | Args | Returns |
|------|------|---------|
| `generate_asset` | `prompt`, `filename`, `output_dir?`, `style_prefix?` | Image path + metadata (width, height, mimeType) |
| `generate_clip` | `prompt`, `duration?` (4/6/8s), `aspect_ratio?`, `reference_image_path?`, `filename?`, `provider?` | Clip path + metadata (mimeType, model, sizeBytes) |
| `stitch_clips` | `clip_paths` (JSON array), `output_path`, `transition?`, `transition_duration?` | Final video path + sizeBytes |
| `compose_video` | `script` (JSON), `output_path`, `template?`, `project_dir?` | Rendered video path + sizeBytes |
| `scaffold_project` | `project_name`, `output_dir?` | Project path + available compositionIds |
| `list_providers` | _(none)_ | Array of providers with name, models, configured status |

## The Two Paths

### Simple path — ffmpeg stitch (fast, no dependencies beyond ffmpeg)
```
generate_asset → generate_clip (with reference image) → stitch_clips → done
```
Use this for: quick clips, social posts, anything that doesn't need text overlays or fancy transitions.

### Rich path — Remotion compose (overlays, transitions, text, music)
```
generate_asset → generate_clip → compose_video (Remotion) → done
```
Use this for: explainer videos, title sequences, anything needing text, timed overlays, or complex transitions. Requires a Remotion project (use `scaffold_project` or the built-in template).

## The Image-to-Video Workflow

This is the core technique for producing consistent, high-quality video. Every scene starts with a reference image.

**Step 1: Generate a reference image.** Use `generate_asset` with a detailed, specific prompt. This image defines what the scene LOOKS like — composition, lighting, characters, setting.

```
generate_asset(
  prompt: "Wide establishing shot of a 1970s detective office, mahogany desk with scattered case files, venetian blinds casting stripe shadows, warm tungsten desk lamp, detective's fedora hanging on coat rack",
  filename: "scene1-office.png",
  style_prefix: "Cinematic, anamorphic lens, golden hour, 35mm film grain, muted teal and orange color grade"
)
```

**Step 2: Generate a video clip using that image as the first frame.** The `reference_image_path` arg tells Veo to start from this image. Your text prompt describes the MOTION, not the scene — the image already defines the scene.

```
generate_clip(
  prompt: "Camera slowly pushes in toward the desk, dust particles floating in the light beams, ceiling fan spinning lazily overhead",
  reference_image_path: "/tmp/video-gen/assets/scene1-office.png",
  duration: 8,
  aspect_ratio: "16:9"
)
```

**Why this works:** You control the starting frame of each clip. Without a reference image, Veo interprets your text prompt freely — two clips with similar prompts can look completely different. With a reference image, the visual identity is locked in.

**Prompt split rule:**
- **Image prompt** → describe the SCENE: composition, lighting, camera angle, objects, characters, colors
- **Video prompt** → describe the MOTION: camera movement, character actions, environmental movement

## Maintaining Visual Consistency

Define these once at the start of production. Reuse them verbatim in every prompt.

### Style prefix
A string prepended to every image generation prompt. Locks in the visual language.

```
style_prefix: "Cinematic, anamorphic lens, shallow depth of field, golden hour lighting, 35mm film grain, muted teal and orange color grade"
```

Pass this as the `style_prefix` arg on `generate_asset` — it gets prepended automatically.

### Character descriptions
Write a paragraph for each character. Copy-paste it into every image prompt where that character appears.

```
DETECTIVE: "A weathered man in his 50s, salt-and-pepper stubble, deep-set brown eyes, wearing a rumpled dark brown suit with a loosened burgundy tie, broad shoulders, scarred knuckles"
```

### Setting descriptions
Same approach — write once, reuse everywhere.

```
OFFICE: "1970s detective office, mahogany desk piled with case files and coffee-stained mugs, venetian blinds half-open, warm tungsten desk lamp, analog rotary phone, coat rack with a fedora"
```

## Planning a Video

Before generating anything, write a production plan. Include:

1. **Story outline** — Beginning, middle, end. What's the narrative arc? What's the payoff?
2. **Scene breakdown** — Scene number, description, shot type (wide/medium/close-up/tracking), duration in seconds
3. **Visual style guide** — The style prefix, color palette, lighting approach
4. **Character sheet** — One paragraph per character, reused verbatim across all prompts
5. **Shot list** — For each scene: the image prompt (scene description) and the clip prompt (motion description)
6. **Assembly plan** — Simple stitch or Remotion composition? What transitions between scenes?

### Example scene breakdown entry

```
Scene 3: The Confrontation
  Shot type: Medium close-up, slightly low angle
  Duration: 6 seconds
  Image prompt: "[style_prefix]. Medium close-up, slightly low angle of [DETECTIVE] leaning forward across interrogation table, harsh overhead fluorescent light, suspect's silhouette in foreground out of focus, sweat beads on detective's forehead"
  Motion prompt: "Detective slams fist on table, leans closer, fluorescent light flickers once, camera slowly pushes in"
  Transition to next: crossfade (1s)
```

## Building Scene by Scene

The production loop — execute this for every scene in the plan:

```
for each scene in the plan:
  1. generate_asset(scene.image_prompt, style_prefix=style_guide, filename=f"scene{n}-{shot_type}.png")
  2. generate_clip(scene.motion_prompt, reference_image_path=scene_image_path, duration=scene.duration)
  3. collect the clip path

# Assemble
stitch_clips(all_clip_paths, output_path="/tmp/video-gen/final.mp4")
# OR
compose_video(script_with_transitions, output_path="/tmp/video-gen/final.mp4")
```

Review each clip after generation. If a clip doesn't look right, regenerate it — the reference image ensures you'll get the same scene, just different motion.

## Long-Form Production (2+ hours)

For long-form content, break the project into manageable chunks:

1. **Break into acts/chapters** — 10-15 minutes each. Each act is a self-contained set of scenes.
2. **Build each act separately** — Generate all scenes for Act 1, stitch Act 1, then move to Act 2.
3. **Final assembly** — Stitch all acts together at the end.
4. **Checkpoint between acts** — Save progress notes in the plan. List completed acts, remaining acts, any corrections needed.

**Budget math:** Each clip is ~8 seconds. For a 2-hour video:
- 7,200 seconds ÷ 8 seconds/clip = **~900 clips**
- That's ~900 image generations + ~900 video generations = **~1,800 API calls**
- At ~3 minutes per Veo generation, that's ~45 hours of serial generation time
- Plan for parallel generation where possible, and batch by act

## Provider Selection

```
list_providers()  → see available providers and their configuration status
```

- Default provider: **veo** (Google Veo 3.0)
- Pass `provider: "name"` to `generate_clip` to use a different one
- The **mock** provider returns a minimal fake MP4 — use it for testing your pipeline without burning API credits
- New providers can be added by implementing the `VideoProvider` interface in `tools/video/lib/providers/`

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
  → Use compose_video with TitleCard template, or generate_asset for a static card

Assembly: stitch_clips with crossfade transitions (0.5s each)
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

Assembly: compose_video with Explainer template for text overlays and section transitions
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

Assembly: stitch_clips with crossfade (0.3s)
→ Add text overlay with compose_video + SocialPost template if needed
```

## Prompt Engineering Tips

### For image generation (`generate_asset`)
Be specific about **static visual details**. The image is a photograph — describe what the camera sees.

| Instead of | Use |
|-----------|-----|
| "A beautiful sunset" | "Golden hour, low angle, sun touching the horizon line, silhouette of pine trees, warm orange and purple gradient sky, anamorphic lens flare" |
| "A man in an office" | "Medium shot, 40s businessman in navy suit, sitting at mahogany desk, warm tungsten desk lamp, venetian blinds casting horizontal shadows, shallow depth of field" |
| "A futuristic city" | "Wide establishing shot, cyberpunk cityscape, neon signs in Japanese and English, rain-wet streets reflecting purple and blue light, flying vehicles in mid-ground, towering glass skyscrapers, low camera angle" |

**Key elements to specify:** camera angle, focal length/lens type, lighting source and color, depth of field, composition (rule of thirds, leading lines), color palette, textures and materials.

### For video generation (`generate_clip`)
Be specific about **motion and change**. The reference image already defines the scene — your prompt drives what MOVES.

| Instead of | Use |
|-----------|-----|
| "A sunset scene" | "Sun slowly sinks below horizon, clouds drift left to right, light shifts from orange to deep purple" |
| "A man working" | "Man picks up phone, glances at it, puts it down, runs hand through hair, leans back in chair" |
| "City at night" | "Camera slowly tracks forward through street, neon signs flicker, rain drops streak across lens, a taxi passes left to right" |

**Key elements to specify:** camera movement (push in, pull out, pan, track, crane, static), character actions (specific gestures, not vibes), environmental motion (wind, water, particles, lights), timing (slow, sudden, gradual).
