/**
 * ScriptedVideo — the primary Remotion composition.
 *
 * Accepts a `VideoScript` JSON as input props and renders each scene as a
 * `<Sequence>`, applying transitions and text overlays.
 */

import React from "react";
import { AbsoluteFill, Img, Sequence, Video, staticFile, useVideoConfig } from "remotion";
import { getTransitionComponent } from "../lib/transitions";
import type { OverlayPosition, OverlayStyle, Scene, TextOverlay, VideoScript } from "../lib/types";
import { validateVideoScript } from "../lib/types";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Renders the background layer for a single scene. */
function SceneBackground({ scene }: { scene: Scene }): React.ReactElement {
	switch (scene.type) {
		case "image":
			return React.createElement(
				AbsoluteFill,
				null,
				React.createElement(Img, {
					src: staticFile(scene.src ?? ""),
					style: { width: "100%", height: "100%", objectFit: "cover" },
				}),
			);

		case "video":
			return React.createElement(
				AbsoluteFill,
				null,
				React.createElement(Video, {
					src: staticFile(scene.src ?? ""),
					style: { width: "100%", height: "100%", objectFit: "cover" },
				}),
			);

		case "text":
			return React.createElement(
				AbsoluteFill,
				{
					style: {
						backgroundColor: "#000",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						padding: "5%",
					},
				},
				React.createElement(
					"div",
					{
						style: {
							color: "#fff",
							fontSize: 64,
							fontFamily: "sans-serif",
							fontWeight: 700,
							textAlign: "center",
							lineHeight: 1.3,
						},
					},
					scene.text ?? "",
				),
			);

		case "color":
			return React.createElement(AbsoluteFill, {
				style: { backgroundColor: scene.color ?? "#000" },
			});

		default: {
			// Defensive — render black for unknown types
			const _exhaustive: never = scene.type as never;
			void _exhaustive;
			return React.createElement(AbsoluteFill, {
				style: { backgroundColor: "#000" },
			});
		}
	}
}

/** Renders a text overlay on top of a scene. */
function OverlayText({ overlay }: { overlay: TextOverlay }): React.ReactElement {
	const position: OverlayPosition = overlay.position ?? "bottom";
	const style: OverlayStyle = overlay.style ?? "caption";

	const alignmentMap: Record<OverlayPosition, React.CSSProperties> = {
		top: { top: "5%", bottom: "auto" },
		center: { top: "50%", transform: "translateY(-50%)" },
		bottom: { bottom: "5%", top: "auto" },
	};

	const fontSizeMap: Record<OverlayStyle, number> = {
		title: 72,
		caption: 36,
		subtitle: 28,
	};

	return React.createElement(
		AbsoluteFill,
		{
			style: {
				display: "flex",
				justifyContent: "center",
				alignItems: "center",
				pointerEvents: "none" as const,
			},
		},
		React.createElement(
			"div",
			{
				style: {
					position: "absolute",
					left: "5%",
					right: "5%",
					textAlign: "center",
					color: "#fff",
					fontFamily: "sans-serif",
					fontWeight: style === "title" ? 700 : 400,
					fontSize: fontSizeMap[style],
					textShadow: "0 2px 8px rgba(0,0,0,0.7)",
					lineHeight: 1.4,
					...alignmentMap[position],
				},
			},
			overlay.text,
		),
	);
}

// ---------------------------------------------------------------------------
// Main composition
// ---------------------------------------------------------------------------

export interface ScriptedVideoProps {
	script: VideoScript;
}

export function ScriptedVideo({ script }: ScriptedVideoProps): React.ReactElement {
	const { fps } = useVideoConfig();

	// Validate — if the script is invalid, render an error slate
	const errors = validateVideoScript(script);
	if (errors.length > 0) {
		return React.createElement(
			AbsoluteFill,
			{
				style: {
					backgroundColor: "#1a0000",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					padding: "5%",
				},
			},
			React.createElement(
				"div",
				{
					style: {
						color: "#ff4444",
						fontSize: 32,
						fontFamily: "monospace",
						fontWeight: 700,
						marginBottom: 24,
					},
				},
				"Invalid VideoScript",
			),
			...errors.map((err, i) =>
				React.createElement(
					"div",
					{
						key: i,
						style: {
							color: "#ff8888",
							fontSize: 20,
							fontFamily: "monospace",
							marginBottom: 8,
						},
					},
					`• ${err}`,
				),
			),
		);
	}

	// Build sequences
	let currentFrame = 0;
	const sequences: React.ReactElement[] = [];

	for (let i = 0; i < script.scenes.length; i++) {
		const scene = script.scenes[i];
		const sceneDurationFrames = Math.round(scene.duration * fps);
		const transitionDurationFrames = scene.transition
			? Math.round(scene.transition.duration * fps)
			: 0;

		// If this scene has a transition and it's not the first scene,
		// start it earlier by the transition duration (overlap with previous).
		const overlapFrames = i > 0 ? transitionDurationFrames : 0;
		const sequenceFrom = currentFrame - overlapFrames;

		const TransitionWrapper =
			scene.transition && i > 0 ? getTransitionComponent(scene.transition.type) : null;

		const sceneContent = React.createElement(
			React.Fragment,
			null,
			React.createElement(SceneBackground, { scene }),
			scene.overlay ? React.createElement(OverlayText, { overlay: scene.overlay }) : null,
		);

		const wrappedContent = TransitionWrapper
			? React.createElement(
					TransitionWrapper,
					{ durationInFrames: transitionDurationFrames },
					sceneContent,
				)
			: sceneContent;

		sequences.push(
			React.createElement(
				Sequence,
				{
					key: i,
					from: Math.max(0, sequenceFrom),
					durationInFrames: sceneDurationFrames,
					name: `Scene ${i}: ${scene.type}`,
				},
				wrappedContent,
			),
		);

		currentFrame += sceneDurationFrames - overlapFrames;
	}

	return React.createElement(AbsoluteFill, null, ...sequences);
}
