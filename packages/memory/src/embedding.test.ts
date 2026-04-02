import { afterEach, describe, expect, mock, test } from "bun:test";
import { EmbeddingService } from "./embedding.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_VECTOR = [0.1, 0.2, 0.3, 0.4, 0.5];

/** Build a service with a real API key (tests should mock fetch). */
function createService(overrides: Partial<ConstructorParameters<typeof EmbeddingService>[0]> = {}) {
	return new EmbeddingService({
		apiKey: "test-key-123",
		dimensions: FAKE_VECTOR.length,
		...overrides,
	});
}

/** Build a mock Response object for fetch. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// Save the original fetch so we can restore it after each test.
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests: embed() — single text
// ---------------------------------------------------------------------------

describe("EmbeddingService.embed()", () => {
	test("successful embedding returns a number array", async () => {
		const mockFetch = mock(() =>
			Promise.resolve(
				jsonResponse({
					data: [{ embedding: FAKE_VECTOR, index: 0 }],
				}),
			),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const result = await service.embed("hello world");

		expect(result).toEqual(FAKE_VECTOR);
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Verify the request shape
		const callArgs = mockFetch.mock.calls[0] as unknown[];
		const url = callArgs[0] as string;
		const init = callArgs[1] as RequestInit;
		expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
		expect(init.method).toBe("POST");

		const body = JSON.parse(init.body as string);
		expect(body.input).toBe("hello world");
		expect(body.model).toBe("openai/text-embedding-3-small");
	});

	test("API error (non-200) returns null without throwing", async () => {
		const mockFetch = mock(() => Promise.resolve(jsonResponse({ error: "Unauthorized" }, 401)));
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const result = await service.embed("test");

		expect(result).toBeNull();
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	test("malformed response (200 but bad shape) returns null", async () => {
		const mockFetch = mock(() =>
			Promise.resolve(jsonResponse({ result: "not the expected shape" })),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const result = await service.embed("test");

		expect(result).toBeNull();
	});

	test("malformed response — empty embedding array returns null", async () => {
		const mockFetch = mock(() => Promise.resolve(jsonResponse({ data: [{ embedding: [] }] })));
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const result = await service.embed("test");

		expect(result).toBeNull();
	});

	test("malformed response — non-numeric values returns null", async () => {
		const mockFetch = mock(() =>
			Promise.resolve(jsonResponse({ data: [{ embedding: ["a", "b", "c"] }] })),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const result = await service.embed("test");

		expect(result).toBeNull();
	});

	test("network error / fetch throws returns null", async () => {
		const mockFetch = mock(() => Promise.reject(new Error("network failure")));
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const result = await service.embed("test");

		expect(result).toBeNull();
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	test("timeout error returns null", async () => {
		const mockFetch = mock(() =>
			Promise.reject(new DOMException("The operation was aborted", "AbortError")),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const result = await service.embed("test");

		expect(result).toBeNull();
	});

	test("no API key returns null without making any fetch call", async () => {
		const mockFetch = mock(() =>
			Promise.resolve(jsonResponse({ data: [{ embedding: FAKE_VECTOR }] })),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService({ apiKey: "" });
		const result = await service.embed("test");

		expect(result).toBeNull();
		expect(mockFetch).toHaveBeenCalledTimes(0);
	});

	test("dimension mismatch still returns the vector (with warning)", async () => {
		const mismatchedVector = [0.1, 0.2]; // 2 dims, service expects 5
		const mockFetch = mock(() =>
			Promise.resolve(
				jsonResponse({
					data: [{ embedding: mismatchedVector, index: 0 }],
				}),
			),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const result = await service.embed("test");

		// Still returns the vector despite mismatch
		expect(result).toEqual(mismatchedVector);
	});

	test("uses custom model and URL when configured", async () => {
		const mockFetch = mock(() =>
			Promise.resolve(jsonResponse({ data: [{ embedding: FAKE_VECTOR }] })),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService({
			model: "custom/model",
			url: "https://custom.example.com/embeddings",
		});
		await service.embed("test");

		const callArgs = mockFetch.mock.calls[0] as unknown[];
		expect(callArgs[0]).toBe("https://custom.example.com/embeddings");
		const body = JSON.parse((callArgs[1] as RequestInit).body as string);
		expect(body.model).toBe("custom/model");
	});
});

// ---------------------------------------------------------------------------
// Tests: embedBatch() — multiple texts
// ---------------------------------------------------------------------------

describe("EmbeddingService.embedBatch()", () => {
	test("successful batch returns array of vectors", async () => {
		const vectors = [
			[0.1, 0.2, 0.3, 0.4, 0.5],
			[0.6, 0.7, 0.8, 0.9, 1.0],
		];
		const mockFetch = mock(() =>
			Promise.resolve(
				jsonResponse({
					data: [
						{ embedding: vectors[0], index: 0 },
						{ embedding: vectors[1], index: 1 },
					],
				}),
			),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const results = await service.embedBatch(["hello", "world"]);

		expect(results).toHaveLength(2);
		expect(results[0]).toEqual(vectors[0]);
		expect(results[1]).toEqual(vectors[1]);
		expect(mockFetch).toHaveBeenCalledTimes(1);

		// Verify batch input is sent as array
		const callArgs = mockFetch.mock.calls[0] as unknown[];
		const body = JSON.parse((callArgs[1] as RequestInit).body as string);
		expect(body.input).toEqual(["hello", "world"]);
	});

	test("batch API error returns array of nulls", async () => {
		const mockFetch = mock(() => Promise.resolve(jsonResponse({ error: "Server error" }, 500)));
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const results = await service.embedBatch(["a", "b", "c"]);

		expect(results).toHaveLength(3);
		expect(results).toEqual([null, null, null]);
	});

	test("batch with partial failures returns nulls for missing items", async () => {
		// API only returns embedding for index 0, not for index 1
		const mockFetch = mock(() =>
			Promise.resolve(
				jsonResponse({
					data: [
						{ embedding: FAKE_VECTOR, index: 0 },
						// index 1 is missing from response
					],
				}),
			),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const results = await service.embedBatch(["good text", "problematic text"]);

		expect(results).toHaveLength(2);
		expect(results[0]).toEqual(FAKE_VECTOR);
		expect(results[1]).toBeNull();
	});

	test("batch with malformed items returns nulls for bad entries", async () => {
		const mockFetch = mock(() =>
			Promise.resolve(
				jsonResponse({
					data: [
						{ embedding: FAKE_VECTOR, index: 0 },
						{ embedding: ["not", "numbers"], index: 1 }, // non-numeric
						{ embedding: [], index: 2 }, // empty
					],
				}),
			),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const results = await service.embedBatch(["ok", "bad-type", "empty"]);

		expect(results).toHaveLength(3);
		expect(results[0]).toEqual(FAKE_VECTOR);
		expect(results[1]).toBeNull();
		expect(results[2]).toBeNull();
	});

	test("batch network error returns array of nulls", async () => {
		const mockFetch = mock(() => Promise.reject(new Error("connection reset")));
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const results = await service.embedBatch(["a", "b"]);

		expect(results).toEqual([null, null]);
	});

	test("batch with no API key returns array of nulls without fetch", async () => {
		const mockFetch = mock(() => Promise.resolve(jsonResponse({})));
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService({ apiKey: "" });
		const results = await service.embedBatch(["a", "b"]);

		expect(results).toEqual([null, null]);
		expect(mockFetch).toHaveBeenCalledTimes(0);
	});

	test("batch with empty texts array returns empty array without fetch", async () => {
		const mockFetch = mock(() => Promise.resolve(jsonResponse({})));
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const results = await service.embedBatch([]);

		expect(results).toEqual([]);
		expect(mockFetch).toHaveBeenCalledTimes(0);
	});

	test("batch with out-of-range index ignores it gracefully", async () => {
		const mockFetch = mock(() =>
			Promise.resolve(
				jsonResponse({
					data: [
						{ embedding: FAKE_VECTOR, index: 0 },
						{ embedding: FAKE_VECTOR, index: 99 }, // out of range
					],
				}),
			),
		);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const service = createService();
		const results = await service.embedBatch(["only one"]);

		expect(results).toHaveLength(1);
		expect(results[0]).toEqual(FAKE_VECTOR);
	});
});

// ---------------------------------------------------------------------------
// Tests: constructor defaults
// ---------------------------------------------------------------------------

describe("EmbeddingService constructor", () => {
	test("dimensions property reflects the configured value", () => {
		const service = createService({ dimensions: 768 });
		expect(service.dimensions).toBe(768);
	});

	test("defaults dimensions to 1536", () => {
		const service = new EmbeddingService({ apiKey: "key" });
		expect(service.dimensions).toBe(1536);
	});
});
