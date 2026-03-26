/**
 * Explainer — longer-form 16:9 composition with titled sections.
 *
 * Input props:
 * - sections: { title: string, content: string, clip?: string }[]
 * - duration: number — total video duration in seconds
 *
 * Layout: Each section gets `duration / sections.length` seconds.
 * A section shows its title (animated), content text, and optional B-roll
 * clip as background. Transitions crossfade between sections.
 */

import React from "react";
import {
	AbsoluteFill,
	Easing,
	Sequence,
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

export interface ExplainerSection {
	title: string;
	content: string;
	/** Optional path to a B-roll clip (relative to public/). */
	clip?: string;
}

export interface ExplainerProps {
	sections: ExplainerSection[];
	duration: number;
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

function ExplainerSectionView({
	section,
	sectionDurationFrames,
}: {
	section: ExplainerSection;
	sectionDurationFrames: number;
}): React.ReactElement {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();

	// Title: spring scale-up + fade in
	const titleScale = spring({
		frame,
		fps,
		config: { damping: 200, stiffness: 120, mass: 0.5 },
		from: 0.85,
		to: 1,
	});

	const titleOpacity = interpolate(frame, [0, Math.round(fps * 0.3)], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: Easing.out(Easing.ease),
	});

	// Content: delayed fade in and slide up
	const contentDelay = Math.round(fps * 0.4);
	const contentOpacity = interpolate(
		frame,
		[contentDelay, contentDelay + Math.round(fps * 0.4)],
		[0, 1],
		{
			extrapolateLeft: "clamp",
			extrapolateRight: "clamp",
		},
	);

	const contentTranslateY = interpolate(
		frame,
		[contentDelay, contentDelay + Math.round(fps * 0.4)],
		[20, 0],
		{
			extrapolateLeft: "clamp",
			extrapolateRight: "clamp",
			easing: Easing.out(Easing.ease),
		},
	);

	// Fade out at end of section
	const fadeOutStart = sectionDurationFrames - Math.round(fps * 0.3);
	const fadeOut = interpolate(frame, [fadeOutStart, sectionDurationFrames], [1, 0], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});

	// Background layer
	const backgroundElement = section.clip
		? React.createElement(
				AbsoluteFill,
				null,
				React.createElement(Video, {
					src: staticFile(section.clip),
					style: { width: "100%", height: "100%", objectFit: "cover" },
				}),
				// Darken for text readability
				React.createElement(AbsoluteFill, {
					style: { backgroundColor: "rgba(0,0,0,0.6)" },
				}),
			)
		: React.createElement(AbsoluteFill, {
				style: {
					background: "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)",
				},
			});

	return React.createElement(
		AbsoluteFill,
		null,
		backgroundElement,

		// Content overlay
		React.createElement(
			AbsoluteFill,
			{
				style: {
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					padding: "8%",
					opacity: fadeOut,
				},
			},

			// Title
			React.createElement(
				"div",
				{
					style: {
						color: "#ffffff",
						fontSize: 64,
						fontFamily: "sans-serif",
						fontWeight: 700,
						lineHeight: 1.2,
						marginBottom: 32,
						transform: `scale(${titleScale})`,
						opacity: titleOpacity,
						textShadow: "0 3px 16px rgba(0,0,0,0.5)",
					},
				},
				section.title,
			),

			// Content
			React.createElement(
				"div",
				{
					style: {
						color: "#e0e0e0",
						fontSize: 36,
						fontFamily: "sans-serif",
						fontWeight: 400,
						lineHeight: 1.5,
						maxWidth: "70%",
						transform: `translateY(${contentTranslateY}px)`,
						opacity: contentOpacity,
						textShadow: "0 2px 8px rgba(0,0,0,0.4)",
					},
				},
				section.content,
			),
		),

		// Section progress indicator (thin bar at bottom)
		React.createElement(
			AbsoluteFill,
			{
				style: {
					top: "auto",
					height: 4,
					bottom: 0,
				},
			},
			React.createElement("div", {
				style: {
					width: `${(frame / sectionDurationFrames) * 100}%`,
					height: "100%",
					backgroundColor: "#4488ff",
					transition: "none",
				},
			}),
		),
	);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export function Explainer({ sections, duration }: ExplainerProps): React.ReactElement {
	const { fps } = useVideoConfig();

	if (!sections || sections.length === 0) {
		return React.createElement(
			AbsoluteFill,
			{
				style: {
					backgroundColor: "#111",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				},
			},
			React.createElement(
				"div",
				{ style: { color: "#f44", fontSize: 32, fontFamily: "sans-serif" } },
				"Explainer: no sections provided",
			),
		);
	}

	const totalFrames = Math.round(duration * fps);
	const sectionDurationFrames = Math.round(totalFrames / sections.length);

	const sequences: React.ReactElement[] = [];
	for (let i = 0; i < sections.length; i++) {
		const from = i * sectionDurationFrames;
		// Last section gets any remaining frames
		const sectionFrames = i === sections.length - 1 ? totalFrames - from : sectionDurationFrames;

		sequences.push(
			React.createElement(
				Sequence,
				{
					key: i,
					from,
					durationInFrames: sectionFrames,
					name: `Section: ${sections[i].title}`,
				},
				React.createElement(ExplainerSectionView, {
					section: sections[i],
					sectionDurationFrames: sectionFrames,
				}),
			),
		);
	}

	return React.createElement(AbsoluteFill, { style: { backgroundColor: "#000" } }, ...sequences);
}

// ---------------------------------------------------------------------------
// Metadata helper
// ---------------------------------------------------------------------------

/** Compute total frames for an Explainer composition. */
export function computeExplainerFrames(props: ExplainerProps, fps: number): number {
	return Math.max(1, Math.round(props.duration * fps));
}
