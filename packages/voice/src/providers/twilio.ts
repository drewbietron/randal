import type { RandalConfig } from "@randal/core";
import Twilio from "twilio";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse";

export interface CreateOutboundCallOptions {
	to: string;
	answerUrl: string;
	statusCallbackUrl?: string;
	machineDetection?: "Enable" | "DetectMessageEnd";
}

export interface ValidateTwilioRequestOptions {
	signature: string;
	url: string;
	params: Record<string, string>;
}

export interface BuildMediaStreamTwimlOptions {
	streamUrl: string;
	statusCallbackUrl?: string;
	parameters?: Record<string, string>;
}

export class TwilioVoiceRuntime {
	readonly client: ReturnType<typeof Twilio>;

	constructor(private config: RandalConfig) {
		this.client = Twilio(config.voice.twilio.accountSid, config.voice.twilio.authToken);
	}

	async createOutboundCall(options: CreateOutboundCallOptions): Promise<{
		callSid: string;
		status: string;
	}> {
		const call = await this.client.calls.create({
			to: options.to,
			from: this.config.voice.twilio.phoneNumber,
			url: options.answerUrl,
			statusCallback: options.statusCallbackUrl,
			statusCallbackMethod: options.statusCallbackUrl ? "POST" : undefined,
			machineDetection: options.machineDetection,
		});

		return {
			callSid: call.sid,
			status: call.status ?? "queued",
		};
	}

	buildMediaStreamTwiml(options: BuildMediaStreamTwimlOptions): string {
		const twiml = new VoiceResponse();
		const connect = twiml.connect();
		const stream = connect.stream({
			url: options.streamUrl,
			statusCallback: options.statusCallbackUrl,
			statusCallbackMethod: options.statusCallbackUrl ? "POST" : undefined,
			track: "inbound_track",
		});

		for (const [name, value] of Object.entries(options.parameters ?? {})) {
			stream.parameter({ name, value });
		}

		return twiml.toString();
	}

	validateRequest(options: ValidateTwilioRequestOptions): boolean {
		return Twilio.validateRequest(
			this.config.voice.twilio.authToken,
			options.signature,
			options.url,
			options.params,
		);
	}
}
