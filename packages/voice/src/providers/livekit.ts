import type { RandalConfig } from "@randal/core";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

export interface CreateVoiceRoomOptions {
	name: string;
	metadata?: string;
	emptyTimeout?: number;
	departureTimeout?: number;
}

export interface GenerateLiveKitTokenOptions {
	roomName: string;
	participantName: string;
	identity?: string;
	metadata?: string;
	ttl?: string | number;
}

export class LiveKitVoiceRuntime {
	readonly roomService: RoomServiceClient;

	constructor(private config: RandalConfig) {
		this.roomService = new RoomServiceClient(
			config.voice.livekit.url,
			config.voice.livekit.apiKey,
			config.voice.livekit.apiSecret,
		);
	}

	async ensureRoom(options: CreateVoiceRoomOptions): Promise<void> {
		await this.roomService.createRoom({
			name: options.name,
			metadata: options.metadata,
			emptyTimeout: options.emptyTimeout ?? 60,
			departureTimeout: options.departureTimeout ?? 20,
		});
	}

	async generateParticipantToken(options: GenerateLiveKitTokenOptions): Promise<string> {
		const token = new AccessToken(
			this.config.voice.livekit.apiKey,
			this.config.voice.livekit.apiSecret,
			{
				identity: options.identity ?? options.participantName,
				name: options.participantName,
				metadata: options.metadata,
				ttl: options.ttl ?? "10m",
			},
		);

		token.addGrant({
			roomJoin: true,
			room: options.roomName,
			canPublish: true,
			canSubscribe: true,
			canPublishData: true,
		});

		return token.toJwt();
	}
}
