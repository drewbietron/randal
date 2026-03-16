import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import { type ChannelAdapter, type ChannelDeps, formatEvent, handleCommand } from "./channel.js";

// Extract voice channel config type from the discriminated union
type VoiceChannelConfig = Extract<RandalConfig["gateway"]["channels"][number], { type: "voice" }>;

// ── Voice session types ─────────────────────────────────────

interface VoiceSession {
	sessionId: string;
	phoneNumber: string;
	startedAt: number;
	lastActivityAt: number;
}

/**
 * Callback to deliver TTS text back to the voice engine.
 */
type TtsCallback = (text: string) => void | Promise<void>;

/**
 * Normalize a phone number for comparison by stripping non-digit characters
 * (except leading +).
 */
function normalizePhone(phone: string): string {
	const trimmed = phone.trim();
	if (trimmed.startsWith("+")) {
		return `+${trimmed.slice(1).replace(/\D/g, "")}`;
	}
	return trimmed.replace(/\D/g, "");
}

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
		// allowFrom filter by phone number
		const allowFrom = this.channelConfig.allowFrom;
		if (allowFrom && allowFrom.length > 0) {
			const normalizedPhone = normalizePhone(phoneNumber);
			const allowed = allowFrom.some((phone) => normalizePhone(phone) === normalizedPhone);
			if (!allowed) {
				this.logger.warn("Voice session rejected by allowFrom filter", {
					sessionId,
					phoneNumber,
				});
				ttsCallback("You are not authorized to use this service.");
				return;
			}
		}

		const session: VoiceSession = {
			sessionId,
			phoneNumber,
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
		};

		this.sessions.set(sessionId, session);
		this.ttsCallbacks.set(sessionId, ttsCallback);

		this.logger.info("Voice session registered", {
			sessionId,
			phoneNumber,
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
			const response = await handleCommand(trimmed, this.deps, origin);
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
