import {
	createVoiceSessionAccess,
	type VoiceAccessClass,
	type VoiceSessionAccess,
} from "@randal/core";
import type { RandalConfig } from "@randal/core";
import { normalizePhone } from "./utils.js";

type VoiceChannelConfig = Extract<RandalConfig["gateway"]["channels"][number], { type: "voice" }>;

export interface VoiceAccessRequest {
	sessionId: string;
	phoneNumber?: string;
	direction: "inbound" | "outbound";
	trustedSource?: boolean;
	requestedAccess?: {
		accessClass?: VoiceAccessClass;
		grants?: string[];
	};
}

export type VoiceAccessResolution =
	| { allowed: true; access: VoiceSessionAccess }
	| { allowed: false; reason: string };

export function resolveVoiceSessionAccess(
	channelConfig: VoiceChannelConfig,
	request: VoiceAccessRequest,
): VoiceAccessResolution {
	const accessConfig = channelConfig.access ?? {
		trustedCallers: [],
		unknownInbound: "deny",
		defaultExternalGrants: [],
	};
	const normalizedPhone = request.phoneNumber ? normalizePhone(request.phoneNumber) : undefined;
	const trustedCallers = new Set(
		[...(channelConfig.allowFrom ?? []), ...(accessConfig.trustedCallers ?? [])]
			.map((phone) => normalizePhone(phone))
			.filter(Boolean),
	);
	const trustedCaller = normalizedPhone ? trustedCallers.has(normalizedPhone) : false;

	if (request.direction === "outbound") {
		const requestedClass = request.requestedAccess?.accessClass ?? "external";
		if (requestedClass === "admin" && request.trustedSource) {
			return {
				allowed: true,
				access: createVoiceSessionAccess({
					accessClass: "admin",
					source: {
						transport: "phone",
						direction: "outbound",
						sessionId: request.sessionId,
						phoneNumber: normalizedPhone,
					},
				}),
			};
		}

		return {
			allowed: true,
			access: createVoiceSessionAccess({
				accessClass: "external",
				grants: request.requestedAccess?.grants ?? accessConfig.defaultExternalGrants,
				source: {
					transport: "phone",
					direction: "outbound",
					sessionId: request.sessionId,
					phoneNumber: normalizedPhone,
				},
			}),
		};
	}

	if (trustedCaller) {
		return {
			allowed: true,
			access: createVoiceSessionAccess({
				accessClass: "admin",
				source: {
					transport: "phone",
					direction: "inbound",
					sessionId: request.sessionId,
					phoneNumber: normalizedPhone,
					trustedCaller: true,
				},
			}),
		};
	}

	if (accessConfig.unknownInbound !== "external") {
		return { allowed: false, reason: "You are not authorized to use this service." };
	}

	return {
		allowed: true,
		access: createVoiceSessionAccess({
			accessClass: "external",
			grants: request.requestedAccess?.grants ?? accessConfig.defaultExternalGrants,
			source: {
				transport: "phone",
				direction: "inbound",
				sessionId: request.sessionId,
				phoneNumber: normalizedPhone,
				trustedCaller: false,
			},
		}),
	};
}
