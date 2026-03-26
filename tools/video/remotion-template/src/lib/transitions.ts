/**
 * Transition utility components for Remotion compositions.
 *
 * Each transition wraps its children and applies an animated effect over
 * `durationInFrames` frames at the start of the sequence.
 */

import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  Easing,
} from "remotion";
import type { TransitionType } from "./types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TransitionProps {
  /** Number of frames the transition lasts. */
  durationInFrames: number;
  /** The content being transitioned *into* (current scene). */
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Crossfade — opacity ramp from 0 → 1
// ---------------------------------------------------------------------------

function Crossfade({ durationInFrames, children }: TransitionProps): React.ReactElement {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.ease),
  });

  return React.createElement(
    AbsoluteFill,
    { style: { opacity } },
    children,
  );
}

// ---------------------------------------------------------------------------
// SlideLeft — slides in from the right edge
// ---------------------------------------------------------------------------

function SlideLeft({ durationInFrames, children }: TransitionProps): React.ReactElement {
  const frame = useCurrentFrame();
  const translateX = interpolate(frame, [0, durationInFrames], [100, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return React.createElement(
    AbsoluteFill,
    { style: { transform: `translateX(${translateX}%)` } },
    children,
  );
}

// ---------------------------------------------------------------------------
// SlideRight — slides in from the left edge
// ---------------------------------------------------------------------------

function SlideRight({ durationInFrames, children }: TransitionProps): React.ReactElement {
  const frame = useCurrentFrame();
  const translateX = interpolate(frame, [0, durationInFrames], [-100, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return React.createElement(
    AbsoluteFill,
    { style: { transform: `translateX(${translateX}%)` } },
    children,
  );
}

// ---------------------------------------------------------------------------
// ZoomIn — scales up from 0.5 → 1 with a fade
// ---------------------------------------------------------------------------

function ZoomIn({ durationInFrames, children }: TransitionProps): React.ReactElement {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationInFrames], [0.5, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const opacity = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return React.createElement(
    AbsoluteFill,
    { style: { transform: `scale(${scale})`, opacity } },
    children,
  );
}

// ---------------------------------------------------------------------------
// Cut — no animation, just renders children immediately
// ---------------------------------------------------------------------------

function Cut({ children }: TransitionProps): React.ReactElement {
  return React.createElement(AbsoluteFill, null, children);
}

// ---------------------------------------------------------------------------
// Registry / factory
// ---------------------------------------------------------------------------

const TRANSITION_MAP: Record<
  TransitionType,
  React.ComponentType<TransitionProps>
> = {
  crossfade: Crossfade,
  "slide-left": SlideLeft,
  "slide-right": SlideRight,
  "zoom-in": ZoomIn,
  cut: Cut,
};

/**
 * Return the React component for a given transition type.
 * Falls back to `Cut` for unknown types (defensive).
 */
export function getTransitionComponent(
  type: TransitionType,
): React.ComponentType<TransitionProps> {
  return TRANSITION_MAP[type] ?? Cut;
}

export { Crossfade, SlideLeft, SlideRight, ZoomIn, Cut };
export type { TransitionProps };
