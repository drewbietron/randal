import { describe, expect, test } from "bun:test";
import { parseCallRequests } from "./call-parser.js";

describe("parseCallRequests", () => {
	test("parses valid call tag with all attributes", () => {
		const output = `<call to="+1234567890" reason="schedule appointment" maxDuration="120">Hello, I'd like to schedule an appointment.</call>`;

		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("+1234567890");
		expect(result[0].reason).toBe("schedule appointment");
		expect(result[0].script).toBe("Hello, I'd like to schedule an appointment.");
		expect(result[0].maxDuration).toBe(120);
	});

	test("parses call tag with only required to attribute", () => {
		const output = `<call to="+15551234567">Call script here.</call>`;

		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("+15551234567");
		expect(result[0].reason).toBeUndefined();
		expect(result[0].maxDuration).toBeUndefined();
		expect(result[0].script).toBe("Call script here.");
	});

	test("parses self-closing call tag", () => {
		const output = `<call to="+1234567890" reason="quick check"/>`;

		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("+1234567890");
		expect(result[0].reason).toBe("quick check");
		expect(result[0].script).toBeUndefined();
	});

	test("parses self-closing call tag with maxDuration", () => {
		const output = `<call to="+1234567890" reason="follow up" maxDuration="60"/>`;

		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].maxDuration).toBe(60);
	});

	test("rejects invalid phone number format", () => {
		const output = `<call to="not-a-phone">script</call>`;
		const result = parseCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("rejects phone number that is too short", () => {
		const output = `<call to="12345">script</call>`;
		const result = parseCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("accepts phone number with spaces and dashes", () => {
		const output = `<call to="+1 (555) 123-4567">script</call>`;
		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("+1 (555) 123-4567");
	});

	test("accepts phone number without plus prefix", () => {
		const output = `<call to="5551234567">script</call>`;
		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("5551234567");
	});

	test("parses multiple call tags in one output", () => {
		const output = `Let me make two calls.
<call to="+1111111111" reason="first call">Hello from call 1.</call>
Some text in between.
<call to="+2222222222" reason="second call">Hello from call 2.</call>`;

		const result = parseCallRequests(output);
		expect(result).toHaveLength(2);
		expect(result[0].to).toBe("+1111111111");
		expect(result[0].reason).toBe("first call");
		expect(result[1].to).toBe("+2222222222");
		expect(result[1].reason).toBe("second call");
	});

	test("parses mix of block and self-closing tags", () => {
		const output = `
<call to="+1111111111" reason="block">Script content.</call>
<call to="+2222222222" reason="self-closing"/>`;

		const result = parseCallRequests(output);
		expect(result).toHaveLength(2);
		expect(result[0].script).toBe("Script content.");
		expect(result[1].script).toBeUndefined();
	});

	test("returns empty array for output with no call tags", () => {
		const output = "Just some regular text without any call tags.";
		const result = parseCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("returns empty array for empty string", () => {
		const result = parseCallRequests("");
		expect(result).toHaveLength(0);
	});

	test("skips invalid call requests but keeps valid ones", () => {
		const output = `
<call to="invalid!@#">bad phone</call>
<call to="+1234567890" reason="valid">good call</call>`;

		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("+1234567890");
	});

	test("handles malformed tags gracefully", () => {
		const output = "<call>missing to attribute</call>";
		const result = parseCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("handles incomplete tag gracefully", () => {
		const output = '<call to="+1234567890"';
		const result = parseCallRequests(output);
		expect(result).toHaveLength(0);
	});

	test("trims whitespace from script content", () => {
		const output = `<call to="+1234567890">
  Hello there.
  How are you?
</call>`;

		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].script).toBe("Hello there.\n  How are you?");
	});

	test("handles call tag surrounded by other text", () => {
		const output =
			'Before the call tag <call to="+9876543210" reason="test">script</call> after the call tag';
		const result = parseCallRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("+9876543210");
	});
});
