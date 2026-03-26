/**
 * SocialPost — 9:16 short-form video composition for social media.
 *
 * Input props:
 * - backgroundClip: string      — path to background video (relative to public/)
 * - caption: string              — main caption text
 * - hashtags?: string[]          — optional array of hashtags
 * - duration: number             — total duration in seconds
 *
 * Layout: Full-bleed background video, darkened overlay, caption animated
 * from the bottom, hashtags below caption. Optimised for portrait/vertical
 * format (1080x1920).
 */

import React from "react";
import {
	AbsoluteFill,
	Easing,
	Video,
	interpolate,
	spring,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SocialPostProps {
	backgroundClip: string;
	caption: string;
	hashtags?: string[];
	duration: number;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export function SocialPost({
	backgroundClip,
	caption,
	hashtags,
	duration,
}: SocialPostProps): React.ReactElement {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();

	// Caption slide-up animation
	const captionTranslateY = spring({
		frame,
		fps,
		config: { damping: 200, stiffness: 80, mass: 0.6 },
		from: 60,
		to: 0,
	});

	const captionOpacity = interpolate(frame, [0, Math.round(fps * 0.5)], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: Easing.out(Easing.ease),
	});

	// Hashtags fade in after caption
	const hashtagDelay = Math.round(fps * 0.6);
	const hashtagOpacity = interpolate(
		frame,
		[hashtagDelay, hashtagDelay + Math.round(fps * 0.4)],
		[0, 1],
		{
			extrapolateLeft: "clamp",
			extrapolateRight: "clamp",
		},
	);

	// Fade out at the end
	const totalFrames = Math.round(duration * fps);
	const fadeOutStart = totalFrames - Math.round(fps * 0.5);
	const globalFade = interpolate(frame, [fadeOutStart, totalFrames], [1, 0], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});

	const hashtagText =
		hashtags && hashtags.length > 0
			? hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
			: null;

	return React.createElement(
		AbsoluteFill,
		{ style: { backgroundColor: "#000" } },

		// Background video
		React.createElement(Video, {
			src: staticFile(backgroundClip),
			style: { width: "100%", height: "100%", objectFit: "cover" },
		}),

		// Dark gradient overlay (bottom-heavy for text readability)
		React.createElement(AbsoluteFill, {
			style: {
				background:
					"linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.8) 100%)",
			},
		}),

		// Text container (bottom-aligned)
		React.createElement(
			AbsoluteFill,
			{
				style: {
					display: "flex",
					flexDirection: "column",
					justifyContent: "flex-end",
					padding: "8%",
					paddingBottom: "12%",
					opacity: globalFade,
				},
			},

			// Caption
			React.createElement(
				"div",
				{
					style: {
						color: "#ffffff",
						fontSize: 48,
						fontFamily: "sans-serif",
						fontWeight: 700,
						lineHeight: 1.3,
						textShadow: "0 2px 12px rgba(0,0,0,0.8)",
						transform: `translateY(${captionTranslateY}px)`,
						opacity: captionOpacity,
					},
				},
				caption,
			),

			// Hashtags
			hashtagText
				? React.createElement(
						"div",
						{
							style: {
								color: "#88ccff",
								fontSize: 28,
								fontFamily: "sans-serif",
								fontWeight: 400,
								marginTop: 16,
								opacity: hashtagOpacity,
								textShadow: "0 1px 6px rgba(0,0,0,0.6)",
							},
						},
						hashtagText,
					)
				: null,
		),
	);
}
