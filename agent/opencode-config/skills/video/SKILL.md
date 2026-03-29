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

## Audio & Narration

| Tool | What it does |
|---|---|
| `generate_speech` | Text-to-speech with ElevenLabs or OpenRouter TTS |
| `list_voices` | List available voices (discover cloned voice IDs) |
| `generate_music` | Generate background music from a text prompt (ElevenLabs) |
| `mix_audio` | Mix multiple audio tracks with volume/delay control (ffmpeg) |
| `attach_audio` | Attach an audio track to a video file (ffmpeg) |

### Voice Cloning Workflow

1. User clones their voice via the ElevenLabs dashboard (external — not in these tools)
2. Use `list_voices` to discover the cloned voice ID
3. Pass the voice ID to `generate_speech` with optional settings:
   - `stability` (0.0–1.0): Higher = more consistent, lower = more expressive
   - `similarity_boost` (0.0–1.0): Higher = closer to original voice
   - `style` (0.0–1.0): Style exaggeration (adds latency)
4. Example:
   ```
   list_voices(provider: "elevenlabs")
   # Find: { voiceId: "abc123", name: "My Cloned Voice", labels: { ... } }
   
   generate_speech(
     text: "Welcome to today's episode.",
     voice: "abc123",
     stability: 0.7,
     similarity_boost: 0.8,
     provider: "elevenlabs"
   )
   ```

### Background Music

Generate music with a text prompt (max 120 seconds per generation):
```
generate_music(
  prompt: "Calm ambient background music, soft piano, no vocals",
  duration: 60,
  provider: "elevenlabs"
)
```

For longer tracks, generate a 60-120s loop and use Remotion's `loop: true` on the `globalAudio` track.

The user can also supply their own music files — just reference the file path directly in the Remotion script's `globalAudio` array.

## Full Production Workflow

The complete pipeline for a narrated video with background music:

```
# Phase 1: Visual Assets
for each scene:
  1. video_generate_asset(scene.image_prompt, style_prefix=style_guide)
  2. video_generate_clip(scene.motion_prompt, reference_image_path=image)

# Phase 2: Audio
3. list_voices(provider: "elevenlabs")   # find cloned voice ID
4. For each scene's narration text:
     generate_speech(text, voice: cloned_voice_id, stability: 0.7, similarity_boost: 0.8)
5. generate_music(prompt: "background music description", duration: 90)

# Phase 3: Assembly (choose one)

# Option A: Simple assembly with ffmpeg
6. stitch_clips(all_clip_paths, transition="crossfade")
7. mix_audio([narration_track, music_track], volumes=[1.0, 0.3])
8. attach_audio(stitched_video, mixed_audio, output)

# Option B: Rich assembly with Remotion (recommended)
6. compose_video(script={
     scenes: [
       {
         media: { type: "video", src: "clip1.mp4" },
         audio: { src: "narration1.mp3", volume: 1.0 },  // per-scene narration
         duration: 8
       },
       ...
     ],
     globalAudio: [
       { src: "background_music.mp3", volume: 0.3, fadeIn: 2, fadeOut: 3, loop: true }
     ]
   })
```

**Remotion audio architecture:**
- Per-scene audio (`scene.audio`): narration, sound effects — one track per scene
- Global audio (`globalAudio[]`): background music — spans entire video, supports multiple simultaneous tracks
- Each track has independent `volume`, `fadeIn`, `fadeOut`, `startOffset`, and `loop` controls

## Environment Setup

Required environment variables:

| Variable | Used By | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | Image gen, OpenRouter TTS | OpenRouter API access |
| `GOOGLE_AI_STUDIO_KEY` | Veo (AI Studio backend) | Video generation via AI Studio |
| `GOOGLE_VERTEX_API_KEY` | Veo (Vertex AI backend) | Video generation via Vertex AI |
| `GOOGLE_CLOUD_PROJECT` | Veo (Vertex AI backend) | GCP project for Vertex AI |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS + music | Voice synthesis and music generation |

**Note on Vertex AI env vars:** The opencode.json config maps `GOOGLE_VERTEX_API_KEY` (your shell) → `VERTEX_AI_API_KEY` (the MCP server process). Set `GOOGLE_VERTEX_API_KEY` in your environment.

**Veo backend fallback:** When both `GOOGLE_VERTEX_API_KEY` and `GOOGLE_AI_STUDIO_KEY` are set, Veo tries Vertex AI first. If Vertex AI returns an auth error (401/403), it automatically falls back to AI Studio. Set both keys for maximum reliability.
