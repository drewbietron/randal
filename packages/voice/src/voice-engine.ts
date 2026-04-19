/**
 * VoiceEngine — manages LiveKit room connections, STT/TTS pipelines, and Twilio SIP integration.
 * R2.1, R2.2: Core voice/video functionality.
 */

import type { RandalConfig } from "@randal/core";
import { createLogger, getVoiceCapability } from "@randal/core";
import { LiveTranscriptionEvents } from "./providers/deepgram.js";
import { type VoiceRuntime, createVoiceRuntime } from "./runtime.js";

const logger = createLogger({ context: { component: "voice-engine" } });

function redactPhoneNumber(phoneNumber: string | undefined): string | undefined {
	if (!phoneNumber) return undefined;
	const digits = phoneNumber.replace(/\D/g, "");
	if (digits.length < 4) return "[redacted]";
	return `***${digits.slice(-4)}`;
}

export interface VoiceSession {
	id: string;
	roomName: string;
	participantId: string;
	callSid?: string;
	startedAt: string;
	duration: number;
	transcript: string[];
	status: "connecting" | "active" | "ended";
	callDirection?: "inbound" | "outbound";
	phoneNumber?: string;
}

interface TwilioMediaStreamState {
	streamSid: string;
	deepgram: {
		on(event: string, listener: (payload: unknown) => void): void;
		send(data: ArrayBufferLike | Blob | string): void;
		requestClose(): void;
	};
	sendMessage: (message: Record<string, unknown>) => void;
	onFinalTranscript: (text: string) => Promise<void>;
	playbackGeneration: number;
	activePlaybackGeneration: number | null;
}

export interface VoiceEngineOptions {
	config: RandalConfig;
	onTranscript?: (sessionId: string, text: string) => void;
	onSessionEnd?: (session: VoiceSession) => void;
	runtime?: VoiceRuntime;
}

/**
 * VoiceEngine manages voice/video sessions via LiveKit.
 * When voice is disabled, all methods are no-ops.
 */
export class VoiceEngine {
	private config: RandalConfig;
	private sessions: Map<string, VoiceSession> = new Map();
	private callSidToSessionId: Map<string, string> = new Map();
	private inboundBootstrapPromises: Map<string, Promise<VoiceSession>> = new Map();
	private onTranscript?: (sessionId: string, text: string) => void;
	private onSessionEnd?: (session: VoiceSession) => void;
	private runtime?: VoiceRuntime;
	private mediaStreams = new Map<string, TwilioMediaStreamState>();
	private started = false;

	constructor(options: VoiceEngineOptions) {
		this.config = options.config;
		this.onTranscript = options.onTranscript;
		this.onSessionEnd = options.onSessionEnd;
		this.runtime = options.runtime;
	}

	get enabled(): boolean {
		return this.config.voice.enabled;
	}

	async start(): Promise<void> {
		const capability = getVoiceCapability(this.config);
		if (!capability.available) {
			logger.warn("Voice engine unavailable, skipping start", {
				reason: capability.reason,
				missing: capability.missing,
			});
			return;
		}

		this.runtime ??= createVoiceRuntime(this.config);
		this.started = true;
		logger.info("Voice engine started", {
			livekitUrl: this.config.voice.livekit.url,
			sttProvider: this.config.voice.stt.provider,
			ttsProvider: this.config.voice.tts.provider,
			ttsVoiceId: capability.ttsVoiceId ?? "provider-default",
			publicBaseUrl: this.runtime.publicBaseUrl,
		});
	}

	async stop(): Promise<void> {
		if (!this.started) return;

		for (const sessionId of this.mediaStreams.keys()) {
			this.stopTwilioMediaStream(sessionId);
		}

		// End all active sessions
		for (const session of this.sessions.values()) {
			if (session.status === "active") {
				await this.endSession(session.id);
			}
		}

		this.started = false;
		logger.info("Voice engine stopped");
	}

	/**
	 * Create a new voice session (for inbound or outbound calls).
	 */
	async createSession(options: {
		roomName: string;
		direction: "inbound" | "outbound";
		phoneNumber?: string;
		callSid?: string;
	}): Promise<VoiceSession> {
		if (!this.started) {
			throw new Error("Voice engine not started");
		}

		const session: VoiceSession = {
			id: `vs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			roomName: options.roomName,
			participantId: `randal-${this.config.name}`,
			startedAt: new Date().toISOString(),
			duration: 0,
			transcript: [],
			status: "connecting",
			callDirection: options.direction,
			phoneNumber: options.phoneNumber,
			callSid: options.callSid,
		};

		await this.runtime?.livekit.ensureRoom({
			name: session.roomName,
			metadata: JSON.stringify({
				sessionId: session.id,
				direction: options.direction,
				phone: redactPhoneNumber(options.phoneNumber),
			}),
		});

		this.sessions.set(session.id, session);
		if (options.callSid) {
			this.callSidToSessionId.set(options.callSid, session.id);
		}
		session.status = "active";

		logger.info("Voice session created", {
			sessionId: session.id,
			roomName: options.roomName,
			direction: options.direction,
			phone: redactPhoneNumber(options.phoneNumber),
		});

		return session;
	}

	/**
	 * Add a transcript line to a session.
	 */
	addTranscript(sessionId: string, text: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		session.transcript.push(text);
		this.onTranscript?.(sessionId, text);
	}

	/**
	 * End a voice session.
	 */
	async endSession(sessionId: string): Promise<VoiceSession | null> {
		const session = this.sessions.get(sessionId);
		if (!session) return null;

		this.stopTwilioMediaStream(sessionId);
		if (session.callSid) {
			this.callSidToSessionId.delete(session.callSid);
		}

		session.status = "ended";
		session.duration = Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000);

		this.onSessionEnd?.(session);

		logger.info("Voice session ended", {
			sessionId,
			duration: session.duration,
			transcriptLines: session.transcript.length,
		});

		return session;
	}

	/**
	 * Get an active session by ID.
	 */
	getSession(sessionId: string): VoiceSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Get all active sessions.
	 */
	getActiveSessions(): VoiceSession[] {
		return [...this.sessions.values()].filter((s) => s.status === "active");
	}

	/**
	 * Join a video call (Zoom/Meet/Teams) via SIP.
	 * R3.4: SIP dial-in support.
	 */
	async joinVideoCall(options: {
		platform: string;
		meetingId: string;
		passcode?: string;
		displayName?: string;
	}): Promise<VoiceSession> {
		logger.info("Joining video call", {
			platform: options.platform,
			meetingId: options.meetingId,
		});

		return this.createSession({
			roomName: `video-${options.platform}-${options.meetingId}`,
			direction: "outbound",
		});
	}

	/**
	 * Initiate an outbound phone call.
	 * R2.5: Outbound call support.
	 */
	async initiateCall(options: {
		to: string;
		reason?: string;
		script?: string;
		maxDuration?: number;
	}): Promise<VoiceSession> {
		if (!this.started) {
			throw new Error("Voice engine not started");
		}
		if (!this.runtime?.publicBaseUrl) {
			throw new Error("Voice public base URL not configured. Set RANDAL_VOICE_PUBLIC_URL.");
		}

		logger.info("Initiating outbound call", {
			to: redactPhoneNumber(options.to),
		});

		const sessionId = `vs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const roomName = `call-${Date.now()}`;
		await this.runtime.livekit.ensureRoom({
			name: roomName,
			metadata: JSON.stringify({
				sessionId,
				direction: "outbound",
				phone: redactPhoneNumber(options.to),
			}),
		});

		const call = await this.runtime.twilio.createOutboundCall({
			to: options.to,
			answerUrl: `${this.runtime.publicBaseUrl}/voice/twiml/outbound/${sessionId}`,
			statusCallbackUrl: `${this.runtime.publicBaseUrl}/voice/twilio/status/${sessionId}`,
		});

		const session: VoiceSession = {
			id: sessionId,
			roomName,
			participantId: `randal-${this.config.name}`,
			callSid: call.callSid,
			startedAt: new Date().toISOString(),
			duration: 0,
			transcript: [],
			status: "active",
			callDirection: "outbound",
			phoneNumber: options.to,
		};

		this.sessions.set(session.id, session);
		this.callSidToSessionId.set(call.callSid, session.id);
		return session;
	}

	private async createInboundSessionForCall(options: {
		callSid: string;
		from?: string;
	}): Promise<VoiceSession> {
		const existingSessionId = this.callSidToSessionId.get(options.callSid);
		if (existingSessionId) {
			const existing = this.sessions.get(existingSessionId);
			if (existing) {
				return existing;
			}
			this.callSidToSessionId.delete(options.callSid);
		}

		return this.createSession({
			roomName: `inbound-${options.callSid}`,
			direction: "inbound",
			phoneNumber: options.from,
			callSid: options.callSid,
		});
	}

	async bootstrapInboundCall(options: {
		callSid: string;
		from?: string;
	}): Promise<VoiceSession> {
		if (!this.started) {
			throw new Error("Voice engine not started");
		}

		const existing = this.callSidToSessionId.get(options.callSid);
		if (existing) {
			const existingSession = this.sessions.get(existing);
			if (existingSession) {
				return existingSession;
			}
			this.callSidToSessionId.delete(options.callSid);
		}

		const inFlight = this.inboundBootstrapPromises.get(options.callSid);
		if (inFlight) {
			return inFlight;
		}

		const promise = this.createInboundSessionForCall(options).finally(() => {
			this.inboundBootstrapPromises.delete(options.callSid);
		});
		this.inboundBootstrapPromises.set(options.callSid, promise);
		return promise;
	}

	/**
	 * Generate a LiveKit room token for browser-based voice.
	 * R2.6: Browser WebRTC voice.
	 */
	async generateRoomToken(roomName: string, participantName: string): Promise<string> {
		if (!this.started) {
			throw new Error("Voice engine not started");
		}
		logger.debug("Generating room token", { roomName, participantName });
		return this.runtime?.livekit.generateParticipantToken({
			roomName,
			participantName,
		}) as Promise<string>;
	}

	buildOutboundTwiml(sessionId: string): string {
		if (!this.runtime?.publicBaseUrl) {
			throw new Error("Voice public base URL not configured. Set RANDAL_VOICE_PUBLIC_URL.");
		}

		return this.runtime.twilio.buildMediaStreamTwiml({
			streamUrl: `${this.runtime.publicBaseUrl.replace(/^http/, "ws")}/voice/media-stream/${sessionId}`,
			statusCallbackUrl: `${this.runtime.publicBaseUrl}/voice/twilio/stream-status/${sessionId}`,
			parameters: { sessionId },
		});
	}

	buildInboundTwiml(sessionId: string): string {
		if (!this.runtime?.publicBaseUrl) {
			throw new Error("Voice public base URL not configured. Set RANDAL_VOICE_PUBLIC_URL.");
		}

		return this.runtime.twilio.buildMediaStreamTwiml({
			streamUrl: `${this.runtime.publicBaseUrl.replace(/^http/, "ws")}/voice/media-stream/${sessionId}`,
			statusCallbackUrl: `${this.runtime.publicBaseUrl}/voice/twilio/stream-status/${sessionId}`,
			parameters: { sessionId },
		});
	}

	validateTwilioRequest(signature: string, url: string, params: Record<string, string>): boolean {
		return this.runtime?.twilio.validateRequest({ signature, url, params }) ?? false;
	}

	startTwilioMediaStream(options: {
		sessionId: string;
		streamSid: string;
		callSid?: string;
		sendMessage: (message: Record<string, unknown>) => void;
		onFinalTranscript: (text: string) => Promise<void>;
	}): void {
		const session = this.sessions.get(options.sessionId);
		if (!session) {
			throw new Error(`Unknown voice session ${options.sessionId}`);
		}

		this.stopTwilioMediaStream(options.sessionId);

		if (options.callSid) {
			session.callSid = options.callSid;
		}

		const deepgram = this.runtime?.deepgram.createTranscriptionStream();
		if (!deepgram) {
			throw new Error("Deepgram runtime unavailable");
		}

		deepgram.on(LiveTranscriptionEvents.Transcript, (payload: unknown) => {
			const data = payload as {
				channel?: { alternatives?: Array<{ transcript?: string }> };
				is_final?: boolean;
				speech_final?: boolean;
			};
			const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
			if (!transcript || !(data.is_final ?? data.speech_final)) {
				return;
			}

			this.addTranscript(options.sessionId, transcript);
			Promise.resolve(options.onFinalTranscript(transcript)).catch((err) => {
				logger.warn("Voice transcript dispatch failed", {
					sessionId: options.sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		});

		this.mediaStreams.set(options.sessionId, {
			streamSid: options.streamSid,
			deepgram,
			sendMessage: options.sendMessage,
			onFinalTranscript: options.onFinalTranscript,
			playbackGeneration: 0,
			activePlaybackGeneration: null,
		});
	}

	handleTwilioMediaChunk(sessionId: string, payloadBase64: string): void {
		const stream = this.mediaStreams.get(sessionId);
		if (!stream) {
			logger.warn("Twilio media chunk for unknown stream", { sessionId });
			return;
		}

		if (stream.activePlaybackGeneration !== null) {
			this.interruptPlayback(sessionId);
		}

		stream.deepgram.send(Buffer.from(payloadBase64, "base64"));
	}

	async speakToSession(sessionId: string, text: string): Promise<void> {
		const stream = this.mediaStreams.get(sessionId);
		if (!stream) {
			logger.warn("TTS requested for session without active media stream", { sessionId });
			return;
		}

		const generation = stream.playbackGeneration + 1;
		stream.playbackGeneration = generation;
		stream.activePlaybackGeneration = generation;
		const audioStream = await this.runtime?.elevenlabs.streamSpeech(text);
		if (!audioStream) {
			if (stream.activePlaybackGeneration === generation) {
				stream.activePlaybackGeneration = null;
			}
			return;
		}

		for await (const chunk of audioStream) {
			if (
				generation !== stream.playbackGeneration ||
				stream.activePlaybackGeneration !== generation
			) {
				break;
			}
			stream.sendMessage({
				event: "media",
				streamSid: stream.streamSid,
				media: { payload: Buffer.from(chunk).toString("base64") },
			});
		}

		if (stream.activePlaybackGeneration === generation) {
			stream.activePlaybackGeneration = null;
		}
	}

	interruptPlayback(sessionId: string): void {
		const stream = this.mediaStreams.get(sessionId);
		if (!stream) return;
		if (stream.activePlaybackGeneration === null) return;
		stream.playbackGeneration += 1;
		stream.activePlaybackGeneration = null;
		stream.sendMessage({ event: "clear", streamSid: stream.streamSid });
	}

	stopTwilioMediaStream(sessionId: string): void {
		const stream = this.mediaStreams.get(sessionId);
		if (!stream) return;
		stream.deepgram.requestClose();
		this.mediaStreams.delete(sessionId);
	}

	async handleTwilioStatusCallback(
		sessionId: string,
		payload: { CallSid?: string; CallStatus?: string },
	): Promise<VoiceSession | null> {
		const session = this.sessions.get(sessionId);
		if (!session) return null;

		if (payload.CallSid) {
			session.callSid = payload.CallSid;
		}

		const status = payload.CallStatus?.toLowerCase();
		if (!status) {
			return session;
		}

		if (["completed", "busy", "failed", "canceled", "no-answer"].includes(status)) {
			return this.endSession(sessionId);
		}

		return session;
	}

	async handleTwilioStreamStatus(
		sessionId: string,
		payload: { StreamEvent?: string },
	): Promise<VoiceSession | null> {
		if (payload.StreamEvent?.toLowerCase() === "stream-stopped") {
			this.stopTwilioMediaStream(sessionId);
		}

		return this.getSession(sessionId) ?? null;
	}
}
