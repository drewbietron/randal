import { describe, expect, test } from "bun:test";
import { hashContent } from "./sync.js";

describe("sync", () => {
	test("hashContent produces consistent SHA-256", () => {
		const hash1 = hashContent("hello world");
		const hash2 = hashContent("hello world");
		expect(hash1).toBe(hash2);
		expect(hash1).toMatch(/^[a-f0-9]{64}$/);
	});

	test("different content produces different hashes", () => {
		const hash1 = hashContent("hello");
		const hash2 = hashContent("world");
		expect(hash1).not.toBe(hash2);
	});
});
