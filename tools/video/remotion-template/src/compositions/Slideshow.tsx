/**
 * Slideshow — renders a sequence of images with transitions.
 *
 * Input props:
 * - images: string[]          — paths to images (relative to public/)
 * - durationPerSlide: number  — seconds each slide is displayed
 * - transition: string        — transition type between slides ("crossfade" | "slide-left" | "zoom-in" | "none")
 *
 * Each image is shown for `durationPerSlide` seconds. Transitions overlap by
 * a fixed 0.5s between consecutive slides.
 */

import React from "react";
import {
	AbsoluteFill,
	Easing,
	Img,
	Sequence,
	interpolate,
	staticFile,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlideshowProps {
	images: string[];
	durationPerSlide: number;
	transition: "crossfade" | "slide-left" | "zoom-in" | "none";
}

// ---------------------------------------------------------------------------
// Transition wrappers
// ---------------------------------------------------------------------------

const TRANSITION_OVERLAP_SECONDS = 0.5;

function CrossfadeIn({
	durationInFrames,
	children,
}: {
	durationInFrames: number;
	children: React.ReactNode;
}): React.ReactElement {
	const frame = useCurrentFrame();
	const opacity = interpolate(frame, [0, durationInFrames], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: Easing.inOut(Easing.ease),
	});
	return React.createElement(AbsoluteFill, { style: { opacity } }, children);
}

function SlideLeftIn({
	durationInFrames,
	children,
}: {
	durationInFrames: number;
	children: React.ReactNode;
}): React.ReactElement {
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

function ZoomInTransition({
	durationInFrames,
	children,
}: {
	durationInFrames: number;
	children: React.ReactNode;
}): React.ReactElement {
	const frame = useCurrentFrame();
	const scale = interpolate(frame, [0, durationInFrames], [0.6, 1], {
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
// Composition
// ---------------------------------------------------------------------------

export function Slideshow({
	images,
	durationPerSlide,
	transition,
}: SlideshowProps): React.ReactElement {
	const { fps } = useVideoConfig();

	if (!images || images.length === 0) {
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
				"Slideshow: no images provided",
			),
		);
	}

	const slideDurationFrames = Math.round(durationPerSlide * fps);
	const transitionFrames = transition !== "none" ? Math.round(TRANSITION_OVERLAP_SECONDS * fps) : 0;

	const sequences: React.ReactElement[] = [];
	let currentFrame = 0;

	for (let i = 0; i < images.length; i++) {
		const overlapFrames = i > 0 ? transitionFrames : 0;
		const sequenceFrom = currentFrame - overlapFrames;

		const imageElement = React.createElement(
			AbsoluteFill,
			null,
			React.createElement(Img, {
				src: staticFile(images[i]),
				style: { width: "100%", height: "100%", objectFit: "cover" },
			}),
		);

		let content: React.ReactElement;
		if (i > 0 && transition !== "none") {
			const TransitionComponent =
				transition === "crossfade"
					? CrossfadeIn
					: transition === "slide-left"
						? SlideLeftIn
						: ZoomInTransition;

			content = React.createElement(
				TransitionComponent,
				{ durationInFrames: transitionFrames },
				imageElement,
			);
		} else {
			content = imageElement;
		}

		sequences.push(
			React.createElement(
				Sequence,
				{
					key: i,
					from: Math.max(0, sequenceFrom),
					durationInFrames: slideDurationFrames,
					name: `Slide ${i + 1}`,
				},
				content,
			),
		);

		currentFrame += slideDurationFrames - overlapFrames;
	}

	return React.createElement(AbsoluteFill, { style: { backgroundColor: "#000" } }, ...sequences);
}

// ---------------------------------------------------------------------------
// Metadata helper
// ---------------------------------------------------------------------------

/** Compute total frames for a Slideshow based on its props. */
export function computeSlideshowFrames(props: SlideshowProps, fps: number): number {
	const { images, durationPerSlide, transition } = props;
	if (!images || images.length === 0) return 1;

	const slideDurationFrames = Math.round(durationPerSlide * fps);
	const transitionFrames = transition !== "none" ? Math.round(TRANSITION_OVERLAP_SECONDS * fps) : 0;

	let total = slideDurationFrames; // first slide, no overlap
	for (let i = 1; i < images.length; i++) {
		total += slideDurationFrames - transitionFrames;
	}

	return Math.max(1, total);
}
