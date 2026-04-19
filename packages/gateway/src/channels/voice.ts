import {
	type RandalConfig,
	type RunnerEvent,
	VOICE_ACCESS_METADATA_KEY,
	type VoiceAccessClass,
	type VoiceSessionAccess,
	createLogger,
	serializeVoiceSessionAccess,
} from "@randal/core";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";
import { normalizePhone } from "./utils.js";
import { resolveVoiceSessionAccess } from "./voice-access.js";

// Extract voice channel config type from the discriminated union
type VoiceChannelConfig = Extract<RandalConfig["gateway"]["channels"][number], { type: "voice" }>;

// ── Voice session types ─────────────────────────────────────

interface VoiceSession {
	sessionId: string;
	phoneNumber: string;
	startedAt: number;
	lastActivityAt: number;
	access: VoiceSessionAccess;
}

/**
 * Callback to deliver TTS text back to the voice engine.
 */
type TtsCallback = (text: string) => void | Promise<void>;

export class VoiceChannel implements ChannelAdapter {
	readonly name = "voice";
	private unsubscribe?: () => void;
	private sessions = new Map<string, VoiceSession>();
	private ttsCallbacks = new Map<string, TtsCallback>();
	private logger = createLogger({ context: { component: "channel:voice" } });

	constructor(
		private channelConfig: VoiceChannelConfig,
		private deps: ChannelDeps,
	) {}

	async start(): Promise<void> {
		// Subscribe to EventBus for outbound notifications
		this.unsubscribe = this.deps.eventBus.subscribe((event) => this.onRunnerEvent(event));
		this.logger.info("Voice channel started");
	}

	/**
	 * Register a voice session. Called by the VoiceEngine when a call/session begins.
	 *
	 * @param sessionId Unique session identifier
	 * @param phoneNumber Caller's phone number
	 * @param ttsCallback Function to call when we need to speak text back
	 */
	registerSession(sessionId: string, phoneNumber: string, ttsCallback: TtsCallback): void {
		this.registerSessionWithAccess(sessionId, phoneNumber, ttsCallback, {});
	}

	registerSessionWithAccess(
		sessionId: string,
		phoneNumber: string,
		ttsCallback: TtsCallback,
		options: {
			direction?: "inbound" | "outbound";
			trustedSource?: boolean;
			requestedAccess?: { accessClass?: VoiceAccessClass; grants?: string[] };
		},
	): void {
		const resolution = resolveVoiceSessionAccess(this.channelConfig, {
			sessionId,
			phoneNumber,
			direction: options.direction ?? "inbound",
			trustedSource: options.trustedSource,
			requestedAccess: options.requestedAccess,
		});
		if (!resolution.allowed) {
			this.logger.warn("Voice session rejected by access policy", {
				sessionId,
				phoneNumber,
				direction: options.direction ?? "inbound",
				requestedAccess: options.requestedAccess,
			});
			ttsCallback(resolution.reason);
			return;
		}

		const session: VoiceSession = {
			sessionId,
			phoneNumber,
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			access: resolution.access,
		};

		this.sessions.set(sessionId, session);
		this.ttsCallbacks.set(sessionId, ttsCallback);

		this.logger.info("Voice session registered", {
			sessionId,
			phoneNumber,
			accessClass: resolution.access.accessClass,
			grants: resolution.access.capabilities.grants,
		});
	}

	/**
	 * Remove a voice session. Called when a call ends.
	 */
	unregisterSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.ttsCallbacks.delete(sessionId);
		this.logger.info("Voice session unregistered", { sessionId });
	}

	/**
	 * Handle transcribed text from STT (speech-to-text).
	 * Called by the VoiceEngine when speech has been transcribed.
	 *
	 * @param sessionId The active voice session
	 * @param text Transcribed text from the caller
	 */
	async handleSttInput(sessionId: string, text: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			this.logger.warn("STT input for unknown session", { sessionId });
			return;
		}

		const ttsCallback = this.ttsCallbacks.get(sessionId);
		if (!ttsCallback) {
			this.logger.warn("No TTS callback for session", { sessionId });
			return;
		}

		// Update activity timestamp
		session.lastActivityAt = Date.now();

		const trimmed = text.trim();
		if (!trimmed) return;

		const origin = {
			channel: "voice" as const,
			replyTo: sessionId,
			from: normalizePhone(session.phoneNumber),
		};

		try {
			const response = await handleCommand(trimmed, this.deps, origin, {
				metadata: {
					[VOICE_ACCESS_METADATA_KEY]: serializeVoiceSessionAccess(session.access),
				},
			});
			await ttsCallback(response);
		} catch (err) {
			this.logger.error("Voice command handling failed", {
				error: err instanceof Error ? err.message : String(err),
				sessionId,
			});
			try {
				await ttsCallback("Something went wrong processing your request.");
			} catch {
				// Can't deliver TTS
			}
		}
	}

	/**
	 * Get the current active sessions (for status/monitoring).
	 */
	getActiveSessions(): VoiceSession[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Check if a session exists and is active.
	 */
	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	private onRunnerEvent(event: RunnerEvent): void {
		// Only send significant events
		const significant = ["job.complete", "job.failed", "job.stuck"];
		if (!significant.includes(event.type)) return;

		// Check origin
		const job = this.deps.runner.getJob(event.jobId);
		if (!job?.origin || job.origin.channel !== "voice") return;

		const sessionId = job.origin.replyTo;
		const ttsCallback = this.ttsCallbacks.get(sessionId);
		if (!ttsCallback) {
			// Session may have ended — log but don't error
			this.logger.info("Voice notification skipped (session ended)", {
				jobId: event.jobId,
				sessionId,
			});
			return;
		}

		const message = formatEvent(event);
		Promise.resolve(ttsCallback(message)).catch((err) => {
			this.logger.warn("Failed to deliver voice notification", {
				error: err instanceof Error ? err.message : String(err),
				jobId: event.jobId,
				sessionId,
			});
		});
	}

	stop(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		// Clear all sessions
		this.sessions.clear();
		this.ttsCallbacks.clear();
		this.logger.info("Voice channel stopped");
	}
}
