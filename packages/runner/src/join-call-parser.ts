/**
 * Parse <join_call> structured tags from agent output for video call participation.
 * R3.5: Extracts join-call requests for Zoom/Meet/Teams meetings.
 */

import { createLogger } from "@randal/core";
import { z } from "zod";

const logger = createLogger({ context: { component: "join-call-parser" } });

export const joinCallRequestSchema = z.object({
	platform: z.enum(["zoom", "meet", "teams", "livekit", "sip"]),
	meetingId: z.string().min(1, "Meeting ID is required"),
	passcode: z.string().optional(),
	displayName: z.string().optional(),
	sipUri: z.string().optional(),
});

export type JoinCallRequest = z.infer<typeof joinCallRequestSchema>;

/**
 * Extract all <join_call> tags from agent output and parse them.
 * Returns array of validated join-call requests.
 *
 * Supports both attribute-style and self-closing:
 * <join_call platform="zoom" meeting_id="123" passcode="456"/>
 * <join_call platform="zoom" meeting_id="123" passcode="456"></join_call>
 */
export function parseJoinCallRequests(output: string): JoinCallRequest[] {
	const requests: JoinCallRequest[] = [];

	// Self-closing format
	const selfClosingRegex = /<join_call\s+([\s\S]*?)\/>/g;
	for (const match of output.matchAll(selfClosingRegex)) {
		const parsed = parseAttributes(match[1]);
		if (parsed) requests.push(parsed);
	}

	// Block format
	const blockRegex = /<join_call\s+([\s\S]*?)>\s*<\/join_call>/g;
	for (const match of output.matchAll(blockRegex)) {
		const parsed = parseAttributes(match[1]);
		if (parsed) requests.push(parsed);
	}

	return requests;
}

function parseAttributes(attrString: string): JoinCallRequest | null {
	const attrs: Record<string, string> = {};
	const attrRegex = /(\w+)="([^"]*)"/g;
	for (const match of attrString.matchAll(attrRegex)) {
		attrs[match[1]] = match[2];
	}

	const raw = {
		platform: attrs.platform,
		meetingId: attrs.meeting_id || attrs.meetingId,
		passcode: attrs.passcode || undefined,
		displayName: attrs.display_name || attrs.displayName || undefined,
		sipUri: attrs.sip_uri || attrs.sipUri || undefined,
	};

	const result = joinCallRequestSchema.safeParse(raw);
	if (result.success) {
		return result.data;
	}

	logger.warn("Invalid join_call request", {
		attrs,
		errors: result.error.issues.map((i) => i.message),
	});
	return null;
}
