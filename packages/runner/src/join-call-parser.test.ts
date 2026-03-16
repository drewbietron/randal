import { describe, expect, test } from "bun:test";
import { parseJoinCallRequests } from "./join-call-parser.js";

describe("parseJoinCallRequests", () => {
	test("parses valid self-closing join_call tag", () => {
		const output = `<join_call platform="zoom" meeting_id="123456789"/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("zoom");
		expect(result[0].meetingId).toBe("123456789");
	});

	test("parses valid block format join_call tag", () => {
		const output = `<join_call platform="meet" meeting_id="abc-defg-hij"></join_call>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("meet");
		expect(result[0].meetingId).toBe("abc-defg-hij");
	});

	test("parses with passcode attribute", () => {
		const output = `<join_call platform="zoom" meeting_id="123" passcode="secret123"/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].passcode).toBe("secret123");
	});

	test("parses with display_name attribute (snake_case)", () => {
		const output = `<join_call platform="zoom" meeting_id="123" display_name="Randal Bot"/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].displayName).toBe("Randal Bot");
	});

	test("parses with displayName attribute (camelCase)", () => {
		const output = `<join_call platform="zoom" meeting_id="123" displayName="Randal Bot"/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].displayName).toBe("Randal Bot");
	});

	test("parses with sip_uri attribute (snake_case)", () => {
		const output = `<join_call platform="sip" meeting_id="room1" sip_uri="sip:room@example.com"/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].sipUri).toBe("sip:room@example.com");
	});

	test("parses with sipUri attribute (camelCase)", () => {
		const output = `<join_call platform="sip" meeting_id="room1" sipUri="sip:room@example.com"/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].sipUri).toBe("sip:room@example.com");
	});

	test("accepts zoom platform", () => {
		const output = `<join_call platform="zoom" meeting_id="123"/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("zoom");
	});

	test("accepts meet platform", () => {
		const output = `<join_call platform="meet" meeting_id="123"/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("meet");
	});

	test("accepts teams platform", () => {
		const output = `<join_call platform="teams" meeting_id="123"/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("teams");
	});

	test("accepts livekit platform", () => {
		const output = `<join_call platform="livekit" meeting_id="123"/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("livekit");
	});

	test("accepts sip platform", () => {
		const output = `<join_call platform="sip" meeting_id="123"/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("sip");
	});

	test("rejects invalid platform", () => {
		const output = `<join_call platform="skype" meeting_id="123"/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("rejects missing meeting_id", () => {
		const output = `<join_call platform="zoom"/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("rejects empty meeting_id", () => {
		const output = `<join_call platform="zoom" meeting_id=""/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("rejects missing platform", () => {
		const output = `<join_call meeting_id="123"/>`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("parses multiple join_call tags", () => {
		// Note: self-closing tags are parsed first, then block tags
		const output = `Join these meetings:
<join_call platform="zoom" meeting_id="111" passcode="aaa"/>
<join_call platform="meet" meeting_id="222"></join_call>
<join_call platform="teams" meeting_id="333" display_name="Bot"/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(3);

		const platforms = result.map((r) => r.platform);
		expect(platforms).toContain("zoom");
		expect(platforms).toContain("meet");
		expect(platforms).toContain("teams");

		const zoom = result.find((r) => r.platform === "zoom");
		expect(zoom?.meetingId).toBe("111");
		expect(zoom?.passcode).toBe("aaa");

		const meet = result.find((r) => r.platform === "meet");
		expect(meet?.meetingId).toBe("222");

		const teams = result.find((r) => r.platform === "teams");
		expect(teams?.displayName).toBe("Bot");
	});

	test("skips invalid tags but keeps valid ones", () => {
		const output = `
<join_call platform="skype" meeting_id="123"/>
<join_call platform="zoom" meeting_id="456"/>
<join_call platform="meet" meeting_id=""/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("zoom");
		expect(result[0].meetingId).toBe("456");
	});

	test("returns empty array for output with no join_call tags", () => {
		const output = "Just some regular text.";
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("returns empty array for empty string", () => {
		const result = parseJoinCallRequests("");
		expect(result).toHaveLength(0);
	});

	test("parses with all attributes combined", () => {
		const output = `<join_call platform="zoom" meeting_id="999" passcode="p4ss" display_name="Agent" sip_uri="sip:agent@call.example"/>`;

		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].platform).toBe("zoom");
		expect(result[0].meetingId).toBe("999");
		expect(result[0].passcode).toBe("p4ss");
		expect(result[0].displayName).toBe("Agent");
		expect(result[0].sipUri).toBe("sip:agent@call.example");
	});

	test("handles tag surrounded by other text", () => {
		const output = `I'll join the call now: <join_call platform="zoom" meeting_id="789"/> OK done.`;
		const result = parseJoinCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].meetingId).toBe("789");
	});
});
