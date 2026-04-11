import { describe, expect, test } from "bun:test";
import { isAllowed, normalizePhone, splitMessage } from "./utils.js";

describe("normalizePhone", () => {
	// Basic formatting
	test("normalizes phone with parentheses and dashes", () => {
		expect(normalizePhone("+1 (555) 111-1111")).toBe("+15551111111");
	});

	test("handles dots as separators", () => {
		expect(normalizePhone("555.123.4567")).toBe("5551234567");
	});

	test("handles spaces as separators", () => {
		expect(normalizePhone("+1 555 123 4567")).toBe("+15551234567");
	});

	test("no leading + returns digits only", () => {
		expect(normalizePhone("  555-123-4567 ")).toBe("5551234567");
	});

	// Protocol prefixes
	test("strips whatsapp: prefix", () => {
		expect(normalizePhone("whatsapp:+1234567890")).toBe("+1234567890");
	});

	test("strips WHATSAPP: prefix (case-insensitive)", () => {
		expect(normalizePhone("WhatsApp:+1234567890")).toBe("+1234567890");
	});

	test("strips signal: prefix", () => {
		expect(normalizePhone("signal:+1234567890")).toBe("+1234567890");
	});

	test("strips tel: prefix", () => {
		expect(normalizePhone("tel:+1234567890")).toBe("+1234567890");
	});

	test("preserves leading + through prefix strip", () => {
		expect(normalizePhone("whatsapp:+1234")).toBe("+1234");
	});

	// Edge cases
	test("empty string", () => {
		expect(normalizePhone("")).toBe("");
	});

	test("whitespace only", () => {
		expect(normalizePhone("   ")).toBe("");
	});

	test("plus sign only", () => {
		expect(normalizePhone("+")).toBe("+");
	});
});

describe("isAllowed", () => {
	// Open access
	test("returns true when allowFrom is undefined", () => {
		expect(isAllowed("anyone", undefined, "id")).toBe(true);
	});

	test("returns true when allowFrom is empty", () => {
		expect(isAllowed("anyone", [], "id")).toBe(true);
	});

	test("returns true when allowFrom is empty (phone mode)", () => {
		expect(isAllowed("anyone", [], "phone")).toBe(true);
	});

	// Phone mode
	test("phone mode normalizes both sides", () => {
		expect(
			isAllowed("+15551234567", ["+1 (555) 123-4567"], "phone"),
		).toBe(true);
	});

	test("phone mode handles whatsapp prefix", () => {
		expect(
			isAllowed("whatsapp:+15551234567", ["+15551234567"], "phone"),
		).toBe(true);
	});

	test("phone mode rejects non-matching", () => {
		expect(
			isAllowed("+15559999999", ["+15551111111"], "phone"),
		).toBe(false);
	});

	// ID mode
	test("id mode is exact match", () => {
		expect(isAllowed("U12345", ["U12345"], "id")).toBe(true);
	});

	test("id mode rejects non-matching", () => {
		expect(isAllowed("U_ALICE", ["U_BOB"], "id")).toBe(false);
	});

	test("id mode is case-sensitive", () => {
		expect(isAllowed("u12345", ["U12345"], "id")).toBe(false);
	});

	test("id mode is the default", () => {
		expect(isAllowed("U12345", ["U12345"])).toBe(true);
	});

	// Email mode
	test("email mode is case-insensitive", () => {
		expect(
			isAllowed("User@Example.COM", ["user@example.com"], "email"),
		).toBe(true);
	});
});

describe("splitMessage", () => {
	test("returns single-element array for short text", () => {
		expect(splitMessage("hello", 100)).toEqual(["hello"]);
	});

	test("returns single-element array for exact-length text", () => {
		expect(splitMessage("abcde", 5)).toEqual(["abcde"]);
	});

	test("splits on newline boundaries", () => {
		const result = splitMessage("aaa\nbbb\nccc", 7);
		for (const chunk of result) {
			expect(chunk.length).toBeLessThanOrEqual(7);
		}
	});

	test("hard-splits lines exceeding limit", () => {
		const result = splitMessage("a".repeat(10), 4);
		expect(result).toEqual(["aaaa", "aaaa", "aa"]);
	});

	test("handles empty string", () => {
		expect(splitMessage("", 100)).toEqual([""]);
	});

	test("preserves content across splits", () => {
		const text = "line1\nline2\nline3";
		const result = splitMessage(text, 11);
		expect(result.join("\n")).toBe(text);
	});
});
