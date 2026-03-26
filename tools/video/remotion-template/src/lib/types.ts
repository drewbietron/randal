/**
 * Video Script Schema — canonical types for the ScriptedVideo composition.
 *
 * A VideoScript describes an entire video as a sequence of scenes with
 * transitions and optional text overlays. These types are consumed by the
 * Remotion compositions and by the orchestration layer (image-gen, video-gen,
 * renderer).
 */

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export type TransitionType = "crossfade" | "slide-left" | "slide-right" | "zoom-in" | "cut";

export interface Transition {
	/** The kind of transition effect. */
	type: TransitionType;
	/** Duration of the transition in seconds. Must be less than the scene duration. */
	duration: number;
}

// ---------------------------------------------------------------------------
// Text Overlay
// ---------------------------------------------------------------------------

export type OverlayPosition = "top" | "center" | "bottom";
export type OverlayStyle = "title" | "caption" | "subtitle";

export interface TextOverlay {
	/** The text to display. */
	text: string;
	/** Vertical placement. Defaults to "bottom". */
	position?: OverlayPosition;
	/** Visual style preset. Defaults to "caption". */
	style?: OverlayStyle;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export type SceneType = "image" | "video" | "text" | "color";

export interface Scene {
	/** What kind of background the scene uses. */
	type: SceneType;
	/**
	 * Path to the image or video file, relative to the Remotion project's
	 * `public/` directory. Required for "image" and "video" types.
	 */
	src?: string;
	/** Text content. Required for "text" type scenes. */
	text?: string;
	/** Background colour (CSS value). Required for "color" type scenes. */
	color?: string;
	/** Duration of this scene in seconds. Must be > 0. */
	duration: number;
	/** Optional transition into this scene. Not applied to the first scene. */
	transition?: Transition;
	/** Optional text overlay rendered on top of the scene background. */
	overlay?: TextOverlay;
}

// ---------------------------------------------------------------------------
// VideoScript (top-level)
// ---------------------------------------------------------------------------

export interface VideoScript {
	/** Optional title for the video (used as metadata, not rendered). */
	title?: string;
	/** Frames per second. Defaults to 30. */
	fps?: number;
	/** Canvas width in pixels. Defaults to 1920. */
	width?: number;
	/** Canvas height in pixels. Defaults to 1080. */
	height?: number;
	/** Ordered list of scenes that compose the video. Must contain >= 1 scene. */
	scenes: Scene[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const VIDEO_DEFAULTS = {
	fps: 30,
	width: 1920,
	height: 1080,
} as const;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Validate that a VideoScript is structurally sound. Returns error messages. */
export function validateVideoScript(script: VideoScript): string[] {
	const errors: string[] = [];

	if (!script.scenes || script.scenes.length === 0) {
		errors.push("VideoScript must contain at least one scene.");
		return errors; // no point checking further
	}

	if (script.fps !== undefined && (script.fps <= 0 || !Number.isFinite(script.fps))) {
		errors.push(`Invalid fps: ${script.fps}. Must be a positive finite number.`);
	}
	if (script.width !== undefined && (script.width <= 0 || !Number.isInteger(script.width))) {
		errors.push(`Invalid width: ${script.width}. Must be a positive integer.`);
	}
	if (script.height !== undefined && (script.height <= 0 || !Number.isInteger(script.height))) {
		errors.push(`Invalid height: ${script.height}. Must be a positive integer.`);
	}

	for (let i = 0; i < script.scenes.length; i++) {
		const scene = script.scenes[i];
		const prefix = `Scene ${i}`;

		if (scene.duration <= 0 || !Number.isFinite(scene.duration)) {
			errors.push(`${prefix}: duration must be a positive finite number (got ${scene.duration}).`);
		}

		switch (scene.type) {
			case "image":
			case "video":
				if (!scene.src || scene.src.trim() === "") {
					errors.push(`${prefix}: type "${scene.type}" requires a non-empty "src" path.`);
				}
				break;
			case "text":
				if (!scene.text || scene.text.trim() === "") {
					errors.push(`${prefix}: type "text" requires a non-empty "text" field.`);
				}
				break;
			case "color":
				if (!scene.color || scene.color.trim() === "") {
					errors.push(`${prefix}: type "color" requires a non-empty "color" field.`);
				}
				break;
			default:
				errors.push(
					`${prefix}: unknown type "${scene.type}". Expected "image", "video", "text", or "color".`,
				);
		}

		if (scene.transition) {
			const validTypes: TransitionType[] = [
				"crossfade",
				"slide-left",
				"slide-right",
				"zoom-in",
				"cut",
			];
			if (!validTypes.includes(scene.transition.type)) {
				errors.push(`${prefix}: unknown transition type "${scene.transition.type}".`);
			}
			if (scene.transition.duration <= 0 || !Number.isFinite(scene.transition.duration)) {
				errors.push(
					`${prefix}: transition duration must be positive (got ${scene.transition.duration}).`,
				);
			}
			if (scene.transition.duration >= scene.duration) {
				errors.push(
					`${prefix}: transition duration (${scene.transition.duration}s) must be less than scene duration (${scene.duration}s).`,
				);
			}
		}
	}

	return errors;
}
