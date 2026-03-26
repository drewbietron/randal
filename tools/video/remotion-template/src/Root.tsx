/**
 * Root — Remotion root component.
 *
 * Registers all available compositions. Remotion discovers these via
 * the entry point (src/index.ts → registerRoot(Root)).
 */

import React from "react";
import { Composition } from "remotion";
import { ScriptedVideo } from "./compositions/ScriptedVideo";
import type { VideoScript } from "./lib/types";
import { VIDEO_DEFAULTS } from "./lib/types";

/**
 * Compute the total duration in frames for a VideoScript.
 * Accounts for transition overlaps between scenes.
 */
function computeTotalFrames(script: VideoScript): number {
  const fps = script.fps ?? VIDEO_DEFAULTS.fps;
  let totalFrames = 0;

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const sceneFrames = Math.round(scene.duration * fps);
    const overlapFrames =
      i > 0 && scene.transition
        ? Math.round(scene.transition.duration * fps)
        : 0;
    totalFrames += sceneFrames - overlapFrames;
  }

  return Math.max(1, totalFrames);
}

/** Default script used for Remotion Studio preview. */
const defaultScript: VideoScript = {
  title: "Preview",
  fps: VIDEO_DEFAULTS.fps,
  width: VIDEO_DEFAULTS.width,
  height: VIDEO_DEFAULTS.height,
  scenes: [
    {
      type: "color",
      color: "#1a1a2e",
      duration: 3,
      overlay: {
        text: "ScriptedVideo Preview",
        position: "center",
        style: "title",
      },
    },
    {
      type: "color",
      color: "#16213e",
      duration: 3,
      transition: { type: "crossfade", duration: 0.5 },
      overlay: {
        text: "Scene 2 — Crossfade transition",
        position: "center",
        style: "caption",
      },
    },
    {
      type: "color",
      color: "#0f3460",
      duration: 3,
      transition: { type: "slide-left", duration: 0.5 },
      overlay: {
        text: "Scene 3 — Slide-left transition",
        position: "bottom",
        style: "subtitle",
      },
    },
  ],
};

export function Root(): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Composition, {
      id: "ScriptedVideo",
      component: ScriptedVideo,
      durationInFrames: computeTotalFrames(defaultScript),
      fps: defaultScript.fps ?? VIDEO_DEFAULTS.fps,
      width: defaultScript.width ?? VIDEO_DEFAULTS.width,
      height: defaultScript.height ?? VIDEO_DEFAULTS.height,
      defaultProps: { script: defaultScript },
      /**
       * calculateMetadata dynamically recomputes dimensions and duration
       * when input props change (e.g., during SSR rendering with custom scripts).
       */
      calculateMetadata: async ({ props }) => {
        const s = props.script;
        return {
          durationInFrames: computeTotalFrames(s),
          fps: s.fps ?? VIDEO_DEFAULTS.fps,
          width: s.width ?? VIDEO_DEFAULTS.width,
          height: s.height ?? VIDEO_DEFAULTS.height,
        };
      },
    }),
  );
}
