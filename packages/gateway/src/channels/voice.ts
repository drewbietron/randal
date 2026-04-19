import { createHash } from "node:crypto";
import { createLogger } from "@randal/core";
import type { RandalConfig, RunnerEvent } from "@randal/core";
import type { ChannelAdapter, ChannelDeps } from "./channel.js";
import { normalizePhone } from "./utils.js";

// Extract voice channel config type from the discriminated union
type VoiceChannelConfig = Extract<RandalConfig["gateway"]["channels"][number], { type: "voice" }>;

// ── Voice session types ─────────────────────────────────────

interface VoiceSession {
	sessionId: string;
	threadId: string;
	phoneNumber: string;
	startedAt: number;
	lastActivityAt: number;
	transcript: string[];
	jobIds: string[];
	turnChain: Promise<void>;
}

interface PendingVoiceTurn {
	sessionId: string;
	stuckNotified: boolean;
	timeout: ReturnType<typeof setTimeout>;
	resolve: (value: { jobId: string; response: string }) => void;
	reject: (reason?: unknown) => void;
}

/**
 * Callback to deliver TTS text back to the voice engine.
 */
type TtsCallback = (text: string) => void | Promise<void>;

const VOICE_RESPONSE_MODIFIER = [
	"Voice response mode is active.",
	"Respond exactly as the same Randal instance, but optimize for spoken delivery.",
	"Use short, natural sentences.",
	"Do not use markdown, code fences, tables, or bullet-heavy formatting.",
	"Do not mention internal job IDs, plans, iterations, or background execution details unless the caller explicitly asks.",
	"If the request is destructive or externally side-effecting, ask for verbal confirmation before taking action.",
].join(" ");

const DEFAULT_VOICE_TURN_TIMEOUT_MS = 30_000;

function buildVoicePrompt(transcript: string): string {
	return `${VOICE_RESPONSE_MODIFIER}\n\nCaller transcript:\n${transcript}`;
}

function summarizeTranscript(transcript: string[]): string {
	if (transcript.length === 0) {
		return "No transcript captured.";
	}

	const joined = transcript.join(" ").replace(/\s+/g, " ").trim();
	if (joined.length <= 240) {
		return joined;
	}

	return `${joined.slice(0, 237)}...`;
}

function summarizeTranscriptForMemory(transcript: string[]): string {
	if (transcript.length === 0) return "No transcript captured.";
	const concise = summarizeTranscript(transcript);
	return concise.replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted-phone]");
}

function redactPhoneNumber(phoneNumber: string): string {
	const digits = phoneNumber.replace(/\D/g, "");
	if (digits.length <= 4) return "[redacted]";
	return `***${digits.slice(-4)}`;
}

function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function resolveVoiceScope(config: ChannelDeps["config"]): string | undefined {
	const workdir = config.runner?.workdir;
	return workdir ? `project:${workdir}` : undefined;
}

export class VoiceChannel implements ChannelAdapter {
	readonly name = "voice";
	private unsubscribe?: () => void;
	private sessions = new Map<string, VoiceSession>();
	private ttsCallbacks = new Map<string, TtsCallback>();
	private pendingTurns = new Map<string, PendingVoiceTurn>();
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
			threadId: `voice:${sessionId}`,
			phoneNumber,
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			transcript: [],
			jobIds: [],
			turnChain: Promise.resolve(),
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
	async unregisterSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		this.ttsCallbacks.delete(sessionId);

		if (session) {
			void this.persistSessionArtifacts(session);
		}

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

		session.transcript.push(trimmed);

		const origin = {
			channel: "voice" as const,
			replyTo: sessionId,
			from: normalizePhone(session.phoneNumber),
		};

		session.turnChain = session.turnChain
			.catch(() => {})
			.then(async () => {
				try {
					await this.logMessage({
						threadId: session.threadId,
						speaker: "user",
						content: trimmed,
						jobId: undefined,
					});

					const result = await this.submitVoiceTurn(session, trimmed, origin);
					await this.logMessage({
						threadId: session.threadId,
						speaker: "randal",
						content: result.response,
						jobId: result.jobId,
					});
					await ttsCallback(result.response);
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
			});

		await session.turnChain;
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
		if (event.type !== "job.stuck") return;
		const pending = this.pendingTurns.get(event.jobId);
		if (!pending || pending.stuckNotified) return;

		pending.stuckNotified = true;
		this.logger.warn("Voice turn appears stuck", {
			jobId: event.jobId,
			sessionId: pending.sessionId,
			indicators: event.data.struggleIndicators,
		});

		const ttsCallback = this.ttsCallbacks.get(pending.sessionId);
		if (!ttsCallback) return;

		Promise.resolve(ttsCallback("I am still working on that request.")).catch((err) => {
			this.logger.warn("Failed to deliver stuck voice notification", {
				jobId: event.jobId,
				sessionId: pending.sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	private async submitVoiceTurn(
		session: VoiceSession,
		transcript: string,
		origin: { channel: "voice"; replyTo: string; from: string },
	): Promise<{ jobId: string; response: string }> {
		const prompt = buildVoicePrompt(transcript);
		const timeoutMs = Number(
			process.env.RANDAL_VOICE_TURN_TIMEOUT_MS ?? DEFAULT_VOICE_TURN_TIMEOUT_MS,
		);
		const { jobId, done } = this.deps.runner.submit({
			prompt,
			origin,
			metadata: {
				voiceSessionId: session.sessionId,
				voiceThreadId: session.threadId,
				voiceMode: "spoken-response",
			},
		});
		session.jobIds.push(jobId);

		let settled = false;
		const finalize = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			const pending = this.pendingTurns.get(jobId);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pendingTurns.delete(jobId);
			}
			fn();
		};

		return new Promise<{ jobId: string; response: string }>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.deps.runner.stop(jobId);
				finalize(() => reject(new Error(`Voice job ${jobId} timed out after ${timeoutMs}ms`)));
			}, timeoutMs);

			this.pendingTurns.set(jobId, {
				sessionId: session.sessionId,
				stuckNotified: false,
				timeout,
				resolve,
				reject,
			});

			const unsubscribe = this.deps.eventBus.subscribe((event) => {
				if (event.jobId !== jobId) return;
				if (event.type === "job.complete") {
					unsubscribe();
					finalize(() =>
						resolve({ jobId, response: (event.data.output ?? event.data.summary ?? "").trim() }),
					);
				}
				if (event.type === "job.failed" || event.type === "job.stopped") {
					unsubscribe();
					finalize(() =>
						reject(new Error(event.data.error ?? `Voice job ${jobId} did not complete`)),
					);
				}
			});

			done.catch((err) => {
				unsubscribe();
				finalize(() => reject(err));
			});
		});
	}

	private async logMessage(input: {
		threadId: string;
		speaker: "user" | "randal";
		content: string;
		jobId?: string;
	}): Promise<void> {
		if (!this.deps.messageManager) return;

		try {
			const scope = resolveVoiceScope(this.deps.config);
			await this.deps.messageManager.add({
				threadId: input.threadId,
				speaker: input.speaker,
				channel: "voice",
				content: input.content,
				timestamp: new Date().toISOString(),
				jobId: input.jobId,
				type: "message",
				...(scope ? { scope } : {}),
			});
		} catch (err) {
			this.logger.warn("Voice transcript persistence failed", {
				threadId: input.threadId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async persistSessionArtifacts(session: VoiceSession): Promise<void> {
		if (this.deps.messageManager) {
			try {
				await this.deps.messageManager.endSession(session.threadId);
			} catch (err) {
				this.logger.warn("Voice thread finalization failed", {
					threadId: session.threadId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		if (!this.deps.memoryManager) return;
		const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
		const summary = summarizeTranscriptForMemory(session.transcript);
		const content = [
			"session-complete",
			`sessionId: ${session.sessionId}`,
			`threadId: ${session.threadId}`,
			"direction: inbound",
			`phone: ${redactPhoneNumber(session.phoneNumber)}`,
			`durationSeconds: ${durationSeconds}`,
			`turnCount: ${session.transcript.length}`,
			`jobIds: ${session.jobIds.join(", ") || "none"}`,
			`transcriptSummary: ${summary}`,
		].join("\n");
		const scope = resolveVoiceScope(this.deps.config);

		try {
			await this.deps.memoryManager.index({
				type: "context",
				file: `voice-session-${session.sessionId}.md`,
				content,
				contentHash: contentHash(content),
				category: "lesson",
				source: "self",
				timestamp: new Date().toISOString(),
				...(scope ? { scope } : {}),
			});
		} catch (err) {
			this.logger.warn("Voice session memory persistence failed", {
				sessionId: session.sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
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
