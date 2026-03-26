---
name: video
description: Video production toolkit. Generate images, create video clips (text-to-video or image-to-video), stitch clips together, and compose rich videos with Remotion. The agent is the director — plan the story, then build scene by scene.
---

# Video Production

You are a video director. These tools give you the primitives — you provide the story, consistency, and creative direction.

## Tools

Use the `video_*` MCP tools:

| Tool | What it does |
|---|---|
| `video_generate_asset` | Generate a still image from a prompt (Gemini 3.1 Flash Image via OpenRouter) |
| `video_generate_clip` | Generate a video clip — text-to-video OR image-to-video (Veo, or any configured provider) |
| `video_stitch_clips` | Concatenate clips into a final video (ffmpeg — simple concat or crossfade) |
| `video_compose_video` | Rich composition via Remotion (overlays, transitions, text, music) |
| `video_scaffold_project` | Create a new Remotion project from template |
| `video_list_providers` | List available video generation providers |

## Two Paths

**Simple path** (no Remotion needed):
`generate_asset` → `generate_clip` (with reference image) → `stitch_clips` → done

**Rich path** (overlays, transitions, text):
`generate_asset` → `generate_clip` → `compose_video` (Remotion) → done

Use the simple path unless you need text overlays, transitions, or complex compositions.

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

# Simple assembly
video_stitch_clips(all_clip_paths, output_path, transition="crossfade")

# OR rich assembly
video_compose_video(script_json, output_path)
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

## Prompt Tips

**For image generation** (static details):
- Be specific about composition, lighting, camera angle, color palette
- Avoid describing action/motion — that's for the video prompt
- Good: "Low angle, golden hour, silhouette of pine trees, warm orange sky, anamorphic lens flare"
- Bad: "A beautiful sunset"

**For video generation** (motion):
- Describe camera movement and subject motion
- The reference image handles the visual details
- Good: "Slow dolly forward, mist swirling, gentle water ripples"
- Bad: "A lake with mountains and trees" (already in the image)
