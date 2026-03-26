/**
 * Root — Remotion root component.
 *
 * Registers all available compositions. Remotion discovers these via
 * the entry point (src/index.ts → registerRoot(Root)).
 */

import React from "react";
import { Composition } from "remotion";
import { Explainer, computeExplainerFrames } from "./compositions/Explainer";
import type { ExplainerProps } from "./compositions/Explainer";
import { ScriptedVideo } from "./compositions/ScriptedVideo";
import { Slideshow, computeSlideshowFrames } from "./compositions/Slideshow";
import type { SlideshowProps } from "./compositions/Slideshow";
import { SocialPost } from "./compositions/SocialPost";
import type { SocialPostProps } from "./compositions/SocialPost";
import { TitleCard } from "./compositions/TitleCard";
import type { TitleCardProps } from "./compositions/TitleCard";
import type { VideoScript } from "./lib/types";
import { VIDEO_DEFAULTS } from "./lib/types";

// ---------------------------------------------------------------------------
// Duration helpers
// ---------------------------------------------------------------------------

/**
 * Compute the total duration in frames for a VideoScript.
 * Accounts for transition overlaps between scenes.
 */
function computeScriptedVideoFrames(script: VideoScript): number {
	const fps = script.fps ?? VIDEO_DEFAULTS.fps;
	let totalFrames = 0;

	for (let i = 0; i < script.scenes.length; i++) {
		const scene = script.scenes[i];
		const sceneFrames = Math.round(scene.duration * fps);
		const overlapFrames =
			i > 0 && scene.transition ? Math.round(scene.transition.duration * fps) : 0;
		totalFrames += sceneFrames - overlapFrames;
	}

	return Math.max(1, totalFrames);
}

// ---------------------------------------------------------------------------
// Default props for Remotion Studio previews
// ---------------------------------------------------------------------------

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

const defaultSlideshowProps: SlideshowProps = {
	images: [],
	durationPerSlide: 3,
	transition: "crossfade",
};

const defaultTitleCardProps: TitleCardProps = {
	title: "Title Card Preview",
	subtitle: "Optional subtitle goes here",
	background: "#1a1a2e",
	duration: 5,
};

const defaultSocialPostProps: SocialPostProps = {
	backgroundClip: "",
	caption: "This is a caption for a social post",
	hashtags: ["video", "ai", "creative"],
	duration: 8,
};

const defaultExplainerProps: ExplainerProps = {
	sections: [
		{ title: "Introduction", content: "Welcome to this explainer video." },
		{ title: "Key Point", content: "Here is the main takeaway from this presentation." },
		{ title: "Conclusion", content: "Thanks for watching!" },
	],
	duration: 15,
};

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function Root(): React.ReactElement {
	return React.createElement(
		React.Fragment,
		null,

		// --- ScriptedVideo ---
		React.createElement(Composition, {
			id: "ScriptedVideo",
			component: ScriptedVideo,
			durationInFrames: computeScriptedVideoFrames(defaultScript),
			fps: defaultScript.fps ?? VIDEO_DEFAULTS.fps,
			width: defaultScript.width ?? VIDEO_DEFAULTS.width,
			height: defaultScript.height ?? VIDEO_DEFAULTS.height,
			defaultProps: { script: defaultScript },
			calculateMetadata: async ({ props }) => {
				const s = props.script;
				return {
					durationInFrames: computeScriptedVideoFrames(s),
					fps: s.fps ?? VIDEO_DEFAULTS.fps,
					width: s.width ?? VIDEO_DEFAULTS.width,
					height: s.height ?? VIDEO_DEFAULTS.height,
				};
			},
		}),

		// --- Slideshow ---
		React.createElement(Composition, {
			id: "Slideshow",
			component: Slideshow,
			durationInFrames: Math.max(
				1,
				computeSlideshowFrames(defaultSlideshowProps, VIDEO_DEFAULTS.fps),
			),
			fps: VIDEO_DEFAULTS.fps,
			width: VIDEO_DEFAULTS.width,
			height: VIDEO_DEFAULTS.height,
			defaultProps: defaultSlideshowProps,
			calculateMetadata: async ({ props }) => ({
				durationInFrames: computeSlideshowFrames(props, VIDEO_DEFAULTS.fps),
			}),
		}),

		// --- TitleCard ---
		React.createElement(Composition, {
			id: "TitleCard",
			component: TitleCard,
			durationInFrames: Math.round(defaultTitleCardProps.duration * VIDEO_DEFAULTS.fps),
			fps: VIDEO_DEFAULTS.fps,
			width: VIDEO_DEFAULTS.width,
			height: VIDEO_DEFAULTS.height,
			defaultProps: defaultTitleCardProps,
			calculateMetadata: async ({ props }) => ({
				durationInFrames: Math.max(1, Math.round(props.duration * VIDEO_DEFAULTS.fps)),
			}),
		}),

		// --- SocialPost (9:16 portrait) ---
		React.createElement(Composition, {
			id: "SocialPost",
			component: SocialPost,
			durationInFrames: Math.round(defaultSocialPostProps.duration * VIDEO_DEFAULTS.fps),
			fps: VIDEO_DEFAULTS.fps,
			width: 1080,
			height: 1920,
			defaultProps: defaultSocialPostProps,
			calculateMetadata: async ({ props }) => ({
				durationInFrames: Math.max(1, Math.round(props.duration * VIDEO_DEFAULTS.fps)),
				width: 1080,
				height: 1920,
			}),
		}),

		// --- Explainer ---
		React.createElement(Composition, {
			id: "Explainer",
			component: Explainer,
			durationInFrames: computeExplainerFrames(defaultExplainerProps, VIDEO_DEFAULTS.fps),
			fps: VIDEO_DEFAULTS.fps,
			width: VIDEO_DEFAULTS.width,
			height: VIDEO_DEFAULTS.height,
			defaultProps: defaultExplainerProps,
			calculateMetadata: async ({ props }) => ({
				durationInFrames: computeExplainerFrames(props, VIDEO_DEFAULTS.fps),
			}),
		}),
	);
}
