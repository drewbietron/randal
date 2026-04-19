/**
 * VoiceEngine — manages LiveKit room connections, STT/TTS pipelines, and Twilio SIP integration.
 * R2.1, R2.2: Core voice/video functionality.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "voice-engine" } });

function base64UrlEncode(input: string): string {
	return Buffer.from(input).toString("base64url");
}

export interface VoiceSession {
	id: string;
	roomName: string;
	participantId: string;
	startedAt: string;
	duration: number;
	transcript: string[];
	status: "connecting" | "active" | "ended";
	callDirection?: "inbound" | "outbound";
	phoneNumber?: string;
}

export interface VoiceEngineOptions {
	config: RandalConfig;
	onTranscript?: (sessionId: string, text: string) => void;
	onSessionEnd?: (session: VoiceSession) => void;
}

/**
 * VoiceEngine manages voice/video sessions via LiveKit.
 * When voice is disabled, all methods are no-ops.
 */
export class VoiceEngine {
	private config: RandalConfig;
	private sessions: Map<string, VoiceSession> = new Map();
	private onTranscript?: (sessionId: string, text: string) => void;
	private onSessionEnd?: (session: VoiceSession) => void;
	private started = false;

	constructor(options: VoiceEngineOptions) {
		this.config = options.config;
		this.onTranscript = options.onTranscript;
		this.onSessionEnd = options.onSessionEnd;
	}

	get enabled(): boolean {
		return this.config.voice.enabled;
	}

	isBrowserVoiceReady(): boolean {
		return Boolean(
			this.config.voice.livekit.url &&
				this.config.voice.livekit.apiKey &&
				this.config.voice.livekit.apiSecret &&
				this.config.voice.stt.apiKey &&
				(this.config.voice.tts.provider === "edge" || this.config.voice.tts.apiKey),
		);
	}

	isPstnVoiceReady(): boolean {
		return Boolean(
			this.isBrowserVoiceReady() &&
				this.config.voice.twilio.accountSid &&
				this.config.voice.twilio.authToken &&
				this.config.voice.twilio.phoneNumber,
		);
	}

	async start(): Promise<void> {
		if (!this.enabled) {
			logger.debug("Voice engine disabled, skipping start");
			return;
		}

		if (!this.isBrowserVoiceReady()) {
			logger.warn("Voice enabled but browser/media config incomplete, skipping start");
			return;
		}

		this.started = true;
		logger.info("Voice engine started", {
			livekitUrl: this.config.voice.livekit.url,
			sttProvider: this.config.voice.stt.provider,
			ttsProvider: this.config.voice.tts.provider,
		});
	}

	async stop(): Promise<void> {
		if (!this.started) return;

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
	}): Promise<VoiceSession> {
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
		};

		this.sessions.set(session.id, session);
		session.status = "active";

		logger.info("Voice session created", {
			sessionId: session.id,
			roomName: options.roomName,
			direction: options.direction,
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
		if (!this.isBrowserVoiceReady()) {
			throw new Error(
				"Browser/media voice requires LiveKit, STT, and TTS configuration before joining calls",
			);
		}

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
		if (!this.isPstnVoiceReady()) {
			throw new Error(
				"PSTN voice requires Twilio accountSid, authToken, and phoneNumber plus browser/media voice configuration",
			);
		}

		logger.info("Initiating outbound call", {
			to: options.to,
			reason: options.reason,
		});

		return this.createSession({
			roomName: `call-${Date.now()}`,
			direction: "outbound",
			phoneNumber: options.to,
		});
	}

	/**
	 * Generate a LiveKit room token for browser-based voice.
	 * R2.6: Browser WebRTC voice.
	 */
	async generateRoomToken(roomName: string, participantName: string): Promise<string> {
		if (!this.isBrowserVoiceReady()) {
			throw new Error(
				"Browser/media voice requires LiveKit, STT, and TTS configuration before generating room tokens",
			);
		}

		logger.debug("Generating room token", { roomName, participantName });

		const now = Math.floor(Date.now() / 1000);
		const header = { alg: "HS256", typ: "JWT" };
		const payload = {
			iss: this.config.voice.livekit.apiKey,
			sub: participantName,
			nbf: now,
			iat: now,
			exp: now + 60 * 60,
			jti: randomUUID(),
			video: {
				room: roomName,
				roomJoin: true,
				canPublish: true,
				canSubscribe: true,
			},
		};

		const encodedHeader = base64UrlEncode(JSON.stringify(header));
		const encodedPayload = base64UrlEncode(JSON.stringify(payload));
		const signingInput = `${encodedHeader}.${encodedPayload}`;
		const signature = createHmac("sha256", this.config.voice.livekit.apiSecret)
			.update(signingInput)
			.digest("base64url");

		return `${signingInput}.${signature}`;
	}
}
