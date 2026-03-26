/**
 * TitleCard — animated text title over an optional background.
 *
 * Input props:
 * - title: string             — the main title text
 * - subtitle?: string         — optional subtitle
 * - background?: string       — CSS color, or path to image/video in public/ (auto-detected by extension)
 * - duration: number          — total duration in seconds
 *
 * Animation: Title fades in and scales up from 0.8 to 1.0 using a spring.
 * Subtitle fades in 0.5s after the title.
 */

import React from "react";
import {
  AbsoluteFill,
  Img,
  Video,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from "remotion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TitleCardProps {
  title: string;
  subtitle?: string;
  background?: string;
  duration: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".avi"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

function isVideoPath(path: string): boolean {
  const lower = path.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BackgroundLayer({ background }: { background?: string }): React.ReactElement {
  if (!background) {
    return React.createElement(AbsoluteFill, {
      style: { backgroundColor: "#0a0a0a" },
    });
  }

  if (isVideoPath(background)) {
    return React.createElement(
      AbsoluteFill,
      null,
      React.createElement(Video, {
        src: staticFile(background),
        style: { width: "100%", height: "100%", objectFit: "cover" },
      }),
      // Darken overlay for text readability
      React.createElement(AbsoluteFill, {
        style: { backgroundColor: "rgba(0,0,0,0.5)" },
      }),
    );
  }

  if (isImagePath(background)) {
    return React.createElement(
      AbsoluteFill,
      null,
      React.createElement(Img, {
        src: staticFile(background),
        style: { width: "100%", height: "100%", objectFit: "cover" },
      }),
      React.createElement(AbsoluteFill, {
        style: { backgroundColor: "rgba(0,0,0,0.4)" },
      }),
    );
  }

  // Treat as CSS color
  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: background },
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export function TitleCard({
  title,
  subtitle,
  background,
  duration,
}: TitleCardProps): React.ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title animation: spring scale + fade
  const titleScale = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 100, mass: 0.5 },
    from: 0.8,
    to: 1,
  });

  const titleOpacity = interpolate(frame, [0, Math.round(fps * 0.4)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.ease),
  });

  // Subtitle animation: delayed fade in
  const subtitleDelay = Math.round(fps * 0.5);
  const subtitleOpacity = interpolate(
    frame,
    [subtitleDelay, subtitleDelay + Math.round(fps * 0.4)],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.ease),
    },
  );

  // Fade out at the end
  const totalFrames = Math.round(duration * fps);
  const fadeOutStart = totalFrames - Math.round(fps * 0.5);
  const fadeOutOpacity = interpolate(
    frame,
    [fadeOutStart, totalFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return React.createElement(
    AbsoluteFill,
    null,
    React.createElement(BackgroundLayer, { background }),
    React.createElement(
      AbsoluteFill,
      {
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "10%",
          opacity: fadeOutOpacity,
        },
      },
      // Title
      React.createElement(
        "div",
        {
          style: {
            color: "#ffffff",
            fontSize: 80,
            fontFamily: "sans-serif",
            fontWeight: 700,
            textAlign: "center",
            lineHeight: 1.2,
            transform: `scale(${titleScale})`,
            opacity: titleOpacity,
            textShadow: "0 4px 20px rgba(0,0,0,0.6)",
          },
        },
        title,
      ),
      // Subtitle
      subtitle
        ? React.createElement(
            "div",
            {
              style: {
                color: "#cccccc",
                fontSize: 36,
                fontFamily: "sans-serif",
                fontWeight: 400,
                textAlign: "center",
                lineHeight: 1.4,
                marginTop: 24,
                opacity: subtitleOpacity,
                textShadow: "0 2px 10px rgba(0,0,0,0.5)",
              },
            },
            subtitle,
          )
        : null,
    ),
  );
}
