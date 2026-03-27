import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	buildComparisonPrompt,
	buildDriftEmphasis,
	generateWithConsistency,
	parseConsistencyResponse,
} from "../consistency";
import type { ConsistencyScore } from "../types";
import { makeProfile } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalEnv = process.env.OPENROUTER_API_KEY;
let savedFetch: typeof globalThis.fetch | undefined;

function saveFetch() {
	savedFetch = globalThis.fetch;
}

function restoreFetch() {
	if (savedFetch) {
		globalThis.fetch = savedFetch;
		savedFetch = undefined;
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consistency", () => {
	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = "test-key-12345";
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.OPENROUTER_API_KEY = originalEnv;
		} else {
			process.env.OPENROUTER_API_KEY = undefined;
		}
		restoreFetch();
	});

	// -----------------------------------------------------------------------
	// parseConsistencyResponse
	// -----------------------------------------------------------------------

	describe("parseConsistencyResponse", () => {
		test("parses clean JSON object", () => {
			const raw = JSON.stringify({
				overall: 8,
				hair: 9,
				face: 7,
				skin: 8,
				build: 6,
				age: 9,
				details: ["hair color matches", "face shape slightly off"],
			});
			const score = parseConsistencyResponse(raw);
			expect(score.overall).toBe(8);
			expect(score.hair).toBe(9);
			expect(score.face).toBe(7);
			expect(score.skin).toBe(8);
			expect(score.build).toBe(6);
			expect(score.age).toBe(9);
			expect(score.details).toEqual(["hair color matches", "face shape slightly off"]);
		});

		test("parses JSON wrapped in ```json code fence", () => {
			const raw =
				'```json\n{"overall": 7, "hair": 8, "face": 6, "skin": 7, "build": 5, "age": 8, "details": ["note"]}\n```';
			const score = parseConsistencyResponse(raw);
			expect(score.overall).toBe(7);
			expect(score.hair).toBe(8);
			expect(score.details).toEqual(["note"]);
		});

		test("parses JSON wrapped in ``` code fence (no language tag)", () => {
			const raw =
				'```\n{"overall": 6, "hair": 5, "face": 7, "skin": 8, "build": 6, "age": 7, "details": []}\n```';
			const score = parseConsistencyResponse(raw);
			expect(score.overall).toBe(6);
			expect(score.face).toBe(7);
		});

		test("extracts scores via regex fallback when JSON is malformed", () => {
			const raw =
				'Here is my analysis: "overall": 8, "hair": 7, "face": 6, "skin": 9, "build": 5, "age": 8, but json is broken {';
			const score = parseConsistencyResponse(raw);
			expect(score.overall).toBe(8);
			expect(score.hair).toBe(7);
			expect(score.face).toBe(6);
			expect(score.skin).toBe(9);
			expect(score.build).toBe(5);
			expect(score.age).toBe(8);
		});

		test("clamps out-of-range scores to 1-10", () => {
			const raw = JSON.stringify({
				overall: 15,
				hair: -2,
				face: 0,
				skin: 11,
				build: 10,
				age: 1,
				details: [],
			});
			const score = parseConsistencyResponse(raw);
			expect(score.overall).toBe(10);
			expect(score.hair).toBe(1);
			expect(score.face).toBe(1);
			expect(score.skin).toBe(10);
			expect(score.build).toBe(10);
			expect(score.age).toBe(1);
		});

		test("defaults missing numeric fields to 5", () => {
			const raw = JSON.stringify({ overall: 8, details: [] });
			const score = parseConsistencyResponse(raw);
			expect(score.overall).toBe(8);
			expect(score.hair).toBe(5);
			expect(score.face).toBe(5);
			expect(score.skin).toBe(5);
			expect(score.build).toBe(5);
			expect(score.age).toBe(5);
		});

		test("defaults missing details to empty array", () => {
			const raw = JSON.stringify({ overall: 7, hair: 7, face: 7, skin: 7, build: 7, age: 7 });
			const score = parseConsistencyResponse(raw);
			expect(score.details).toEqual([]);
		});

		test("returns all defaults for empty string", () => {
			const score = parseConsistencyResponse("");
			expect(score.overall).toBe(5);
			expect(score.details).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	// buildComparisonPrompt
	// -----------------------------------------------------------------------

	describe("buildComparisonPrompt", () => {
		test("includes CID block in output", () => {
			const profile = makeProfile();
			const prompt = buildComparisonPrompt(profile);
			expect(prompt).toContain("mid-30s female");
			expect(prompt).toContain("East Asian");
			expect(prompt).toContain("jet black");
		});

		test("includes dimension names (hair, face, skin, build, age)", () => {
			const profile = makeProfile();
			const prompt = buildComparisonPrompt(profile);
			expect(prompt).toContain("- hair:");
			expect(prompt).toContain("- face:");
			expect(prompt).toContain("- skin:");
			expect(prompt).toContain("- build:");
			expect(prompt).toContain("- age:");
		});

		test("includes scoring instructions (1-10)", () => {
			const profile = makeProfile();
			const prompt = buildComparisonPrompt(profile);
			expect(prompt).toContain("1-10");
		});
	});

	// -----------------------------------------------------------------------
	// buildDriftEmphasis
	// -----------------------------------------------------------------------

	describe("buildDriftEmphasis", () => {
		test("returns empty string when all scores >= 7", () => {
			const score: ConsistencyScore = {
				overall: 8,
				hair: 9,
				face: 8,
				skin: 7,
				build: 8,
				age: 9,
				details: [],
			};
			const profile = makeProfile();
			const result = buildDriftEmphasis(score, profile);
			expect(result).toBe("");
		});

		test("returns emphasis for hair when hair score < 7", () => {
			const score: ConsistencyScore = {
				overall: 5,
				hair: 4,
				face: 8,
				skin: 8,
				build: 8,
				age: 8,
				details: [],
			};
			const profile = makeProfile();
			const result = buildDriftEmphasis(score, profile);
			expect(result).toContain("CRITICAL");
			expect(result).toContain("hair must be");
			expect(result).toContain("jet black");
		});

		test("returns emphasis for multiple drifted dimensions", () => {
			const score: ConsistencyScore = {
				overall: 4,
				hair: 3,
				face: 4,
				skin: 3,
				build: 3,
				age: 3,
				details: [],
			};
			const profile = makeProfile();
			const result = buildDriftEmphasis(score, profile);
			expect(result).toContain("hair must be");
			expect(result).toContain("face must have");
			expect(result).toContain("skin must be");
			expect(result).toContain("build must be");
			expect(result).toContain("must appear");
		});

		test("emphasis text includes character's actual CID values", () => {
			const score: ConsistencyScore = {
				overall: 3,
				hair: 3,
				face: 3,
				skin: 8,
				build: 8,
				age: 8,
				details: [],
			};
			const profile = makeProfile();
			const result = buildDriftEmphasis(score, profile);
			// Hair emphasis should include the character's specific hair fields
			expect(result).toContain(profile.physical.hair.color);
			expect(result).toContain(profile.physical.hair.length);
			// Face emphasis should include face-specific fields
			expect(result).toContain(profile.physical.face_shape);
			expect(result).toContain(profile.physical.eyes.color);
		});
	});

	// -----------------------------------------------------------------------
	// generateWithConsistency
	// -----------------------------------------------------------------------

	describe("generateWithConsistency", () => {
		test("calls generateFn once when verify=false, returns null score", async () => {
			let callCount = 0;
			const generateFn = async (_prompt: string) => {
				callCount++;
				return { imagePath: "/tmp/test.png" };
			};
			const result = await generateWithConsistency({
				generateFn,
				prompt: "test prompt",
				profile: makeProfile(),
				verifyConsistency: false,
				characterName: "test",
			});
			expect(callCount).toBe(1);
			expect(result.consistency_score).toBeNull();
			expect(result.retries_used).toBe(0);
			expect(result.character_name).toBe("test");
			expect(result.image_path).toBe("/tmp/test.png");
		});

		test("returns immediately when score >= minScore on first attempt", async () => {
			let generateCallCount = 0;

			// Mock fetch to return a passing consistency score
			saveFetch();
			globalThis.fetch = async () => {
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										overall: 9,
										hair: 9,
										face: 8,
										skin: 9,
										build: 8,
										age: 9,
										details: ["excellent match"],
									}),
								},
							},
						],
					}),
					{ status: 200 },
				);
			};

			// Create a fake image file for analyzeImage to read
			const fakePath = `/tmp/char-test-${crypto.randomUUID()}.png`;
			const pngHeader = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
				0x52,
			]);
			await Bun.write(fakePath, Buffer.concat([pngHeader, Buffer.alloc(200, 0xaa)]));

			const generateFn = async (_prompt: string) => {
				generateCallCount++;
				return { imagePath: fakePath };
			};

			const result = await generateWithConsistency({
				generateFn,
				prompt: "test prompt",
				profile: makeProfile(),
				verifyConsistency: true,
				maxRetries: 2,
				minScore: 7,
				characterName: "test",
			});

			expect(generateCallCount).toBe(1);
			expect(result.consistency_score).not.toBeNull();
			expect(result.consistency_score?.overall).toBe(9);
			expect(result.retries_used).toBe(0);

			// Cleanup
			try {
				(await Bun.file(fakePath).exists()) &&
					(await import("node:fs/promises")).then((fs) => fs.rm(fakePath));
			} catch {
				/* ignore */
			}
		});

		test("retries and returns best attempt when score below threshold", async () => {
			let generateCallCount = 0;

			// Alternate between low and medium scores
			const scores = [
				{ overall: 4, hair: 3, face: 5, skin: 4, build: 5, age: 4, details: ["low"] },
				{ overall: 6, hair: 6, face: 6, skin: 6, build: 6, age: 6, details: ["medium"] },
				{ overall: 5, hair: 5, face: 5, skin: 5, build: 5, age: 5, details: ["low again"] },
			];

			saveFetch();
			globalThis.fetch = async () => {
				const scoreIdx = Math.min(generateCallCount - 1, scores.length - 1);
				const score = scores[scoreIdx >= 0 ? scoreIdx : 0];
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: JSON.stringify(score) } }],
					}),
					{ status: 200 },
				);
			};

			const fakePath = `/tmp/char-test-retry-${crypto.randomUUID()}.png`;
			const pngHeader = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
				0x52,
			]);
			await Bun.write(fakePath, Buffer.concat([pngHeader, Buffer.alloc(200, 0xaa)]));

			const generateFn = async (_prompt: string) => {
				generateCallCount++;
				return { imagePath: fakePath };
			};

			const result = await generateWithConsistency({
				generateFn,
				prompt: "test prompt",
				profile: makeProfile(),
				verifyConsistency: true,
				maxRetries: 2,
				minScore: 8, // Set high so all attempts fail
				characterName: "test",
			});

			// Should have tried 3 times (1 initial + 2 retries)
			expect(generateCallCount).toBe(3);
			// Should return the best scoring attempt (overall: 6)
			expect(result.consistency_score).not.toBeNull();
			expect(result.consistency_score?.overall).toBe(6);
			expect(result.retries_used).toBe(2);

			try {
				(await Bun.file(fakePath).exists()) &&
					(await import("node:fs/promises")).then((fs) => fs.rm(fakePath));
			} catch {
				/* ignore */
			}
		});

		test("respects maxRetries=0 (single attempt)", async () => {
			let generateCallCount = 0;

			saveFetch();
			globalThis.fetch = async () => {
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										overall: 3,
										hair: 3,
										face: 3,
										skin: 3,
										build: 3,
										age: 3,
										details: [],
									}),
								},
							},
						],
					}),
					{ status: 200 },
				);
			};

			const fakePath = `/tmp/char-test-noretry-${crypto.randomUUID()}.png`;
			const pngHeader = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
				0x52,
			]);
			await Bun.write(fakePath, Buffer.concat([pngHeader, Buffer.alloc(200, 0xaa)]));

			const generateFn = async (_prompt: string) => {
				generateCallCount++;
				return { imagePath: fakePath };
			};

			const result = await generateWithConsistency({
				generateFn,
				prompt: "test prompt",
				profile: makeProfile(),
				verifyConsistency: true,
				maxRetries: 0,
				minScore: 8,
				characterName: "test",
			});

			expect(generateCallCount).toBe(1);
			expect(result.retries_used).toBe(0);

			try {
				(await Bun.file(fakePath).exists()) &&
					(await import("node:fs/promises")).then((fs) => fs.rm(fakePath));
			} catch {
				/* ignore */
			}
		});
	});
});
