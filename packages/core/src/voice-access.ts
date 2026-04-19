export const VOICE_ACCESS_METADATA_KEY = "RANDAL_VOICE_ACCESS";

export type VoiceAccessClass = "admin" | "external";
export type VoiceSessionTransport = "phone" | "browser";
export type VoiceSessionDirection = "inbound" | "outbound";

export interface VoiceCapabilityEnvelope {
	defaultPolicy: "deny";
	grants: string[];
}

export interface VoiceSessionSourceFacts {
	transport: VoiceSessionTransport;
	direction: VoiceSessionDirection;
	sessionId?: string;
	phoneNumber?: string;
	trustedCaller?: boolean;
}

export interface VoiceSessionAccess {
	version: 1;
	accessClass: VoiceAccessClass;
	capabilities: VoiceCapabilityEnvelope;
	source: VoiceSessionSourceFacts;
}

export function createVoiceSessionAccess(input: {
	accessClass: VoiceAccessClass;
	grants?: string[];
	source: VoiceSessionSourceFacts;
}): VoiceSessionAccess {
	return {
		version: 1,
		accessClass: input.accessClass,
		capabilities: {
			defaultPolicy: "deny",
			grants: Array.from(new Set(input.grants?.filter(Boolean) ?? [])).sort(),
		},
		source: input.source,
	};
}

export function serializeVoiceSessionAccess(access: VoiceSessionAccess): string {
	return JSON.stringify(access);
}

export function parseVoiceSessionAccess(raw: string | undefined): VoiceSessionAccess | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as VoiceSessionAccess;
		if (
			parsed?.version !== 1 ||
			(parsed?.accessClass !== "admin" && parsed?.accessClass !== "external") ||
			parsed?.capabilities?.defaultPolicy !== "deny" ||
			!Array.isArray(parsed?.capabilities?.grants) ||
			!parsed.capabilities.grants.every(
				(grant) => typeof grant === "string" && grant.trim().length > 0,
			) ||
			(parsed?.source?.transport !== "phone" && parsed?.source?.transport !== "browser") ||
			(parsed?.source?.direction !== "inbound" && parsed?.source?.direction !== "outbound") ||
			(parsed.source.sessionId !== undefined && typeof parsed.source.sessionId !== "string") ||
			(parsed.source.phoneNumber !== undefined && typeof parsed.source.phoneNumber !== "string") ||
			(parsed.source.trustedCaller !== undefined &&
				typeof parsed.source.trustedCaller !== "boolean") ||
			(parsed.source.transport === "browser" && parsed.source.phoneNumber !== undefined)
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function voiceAccessHasGrant(access: VoiceSessionAccess | null, grant: string): boolean {
	if (!access) return false;
	if (access.accessClass === "admin") return true;
	return access.capabilities.grants.includes(grant);
}
