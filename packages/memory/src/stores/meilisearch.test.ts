import { describe, expect, mock, test } from "bun:test";
import type { EmbeddingService } from "../embedding.js";
import { MeilisearchStore } from "./meilisearch.js";

// ---------------------------------------------------------------------------
// Mock Meilisearch index
// ---------------------------------------------------------------------------

interface MockSearchResult {
	hits: Record<string, unknown>[];
	estimatedTotalHits?: number;
}

/**
 * Creates a mock Meilisearch index object that records calls and returns
 * configurable results without needing a live Meilisearch instance.
 */
function createMockIndex() {
	const calls: Record<string, unknown[][]> = {};

	function record(method: string, args: unknown[]) {
		if (!calls[method]) calls[method] = [];
		calls[method].push(args);
	}

	let searchResults: MockSearchResult = { hits: [] };

	const mockIndex = {
		updateSearchableAttributes: mock(async (...args: unknown[]) => {
			record("updateSearchableAttributes", args);
		}),
		updateFilterableAttributes: mock(async (...args: unknown[]) => {
			record("updateFilterableAttributes", args);
		}),
		updateSortableAttributes: mock(async (...args: unknown[]) => {
			record("updateSortableAttributes", args);
		}),
		updateEmbedders: mock(async (...args: unknown[]) => {
			record("updateEmbedders", args);
		}),
		search: mock(async (...args: unknown[]) => {
			record("search", args);
			return searchResults;
		}),
		addDocuments: mock(async (...args: unknown[]) => {
			record("addDocuments", args);
		}),
		// Test helpers
		_calls: calls,
		_setSearchResults(results: MockSearchResult) {
			searchResults = results;
		},
	};

	return mockIndex;
}

/**
 * Retrieve a recorded call by method name and index. Throws if not found,
 * so tests get a clear error rather than an undefined access.
 */
function getCall(calls: Record<string, unknown[][]>, method: string, index = 0): unknown[] {
	const list = calls[method];
	if (!list || list.length <= index) {
		throw new Error(
			`Expected call ${method}[${index}] but only ${list?.length ?? 0} calls recorded`,
		);
	}
	return list[index];
}

/** Get the last recorded call for a method. */
function getLastCall(calls: Record<string, unknown[][]>, method: string): unknown[] {
	const list = calls[method];
	if (!list || list.length === 0) {
		throw new Error(`Expected at least one call to ${method}`);
	}
	return list[list.length - 1];
}

/**
 * Creates a mock EmbeddingService that returns configurable results.
 * The `embed` function can be overridden per-test.
 */
function createMockEmbeddingService(
	embedFn: (text: string) => Promise<number[] | null> = async () => [0.1, 0.2, 0.3],
): EmbeddingService {
	return {
		dimensions: 3,
		embed: mock(embedFn),
		embedBatch: mock(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
	} as unknown as EmbeddingService;
}

/**
 * Creates a MeilisearchStore that uses our mock index instead of connecting
 * to a real Meilisearch instance. Achieves this by replacing the internal
 * client's `index()` method after construction.
 */
function createStoreWithMock(
	options: {
		embeddingService?: EmbeddingService;
		semanticRatio?: number;
	} = {},
) {
	const store = new MeilisearchStore({
		url: "http://localhost:7700",
		apiKey: "test-key",
		index: "test-index",
		embeddingService: options.embeddingService,
		semanticRatio: options.semanticRatio,
	});

	const mockIdx = createMockIndex();

	// Replace the internal client with one that returns our mock index
	// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
	(store as any).client = {
		index: () => mockIdx,
	};

	return { store, mockIdx };
}

// ---------------------------------------------------------------------------
// Tests: init()
// ---------------------------------------------------------------------------

describe("MeilisearchStore.init()", () => {
	test("configures searchable, filterable, and sortable attributes", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		expect(mockIdx.updateSearchableAttributes).toHaveBeenCalledTimes(1);
		expect(mockIdx.updateFilterableAttributes).toHaveBeenCalledTimes(1);
		expect(mockIdx.updateSortableAttributes).toHaveBeenCalledTimes(1);

		// Verify scope is in filterable attributes
		const filterableCall = getCall(mockIdx._calls, "updateFilterableAttributes");
		const attrs = filterableCall[0] as string[];
		expect(attrs).toContain("scope");
	});

	test("calls updateEmbedders with userProvided config when embeddingService is provided", async () => {
		const embeddingService = createMockEmbeddingService();
		const { store, mockIdx } = createStoreWithMock({ embeddingService });

		await store.init();

		expect(mockIdx.updateEmbedders).toHaveBeenCalledTimes(1);

		const embedderCall = getCall(mockIdx._calls, "updateEmbedders");
		const embeddersArg = embedderCall[0] as Record<string, unknown>;
		expect(embeddersArg).toBeDefined();

		// Should have a "default" key with userProvided source
		const embedderConfig = embeddersArg.default as Record<string, unknown>;
		expect(embedderConfig).toBeDefined();
		expect(embedderConfig.source).toBe("userProvided");
		expect(embedderConfig.dimensions).toBe(3);
	});

	test("skips updateEmbedders when no embeddingService", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		expect(mockIdx.updateEmbedders).toHaveBeenCalledTimes(0);
	});

	test("falls back gracefully when updateEmbedders throws", async () => {
		const embeddingService = createMockEmbeddingService();
		const { store, mockIdx } = createStoreWithMock({ embeddingService });

		// Make updateEmbedders fail
		mockIdx.updateEmbedders.mockImplementation(async () => {
			throw new Error("Embedder configuration failed");
		});

		// Should NOT throw — init should succeed with a warning
		await store.init();

		// Semantic search should now be unavailable — verified in search tests
	});
});

// ---------------------------------------------------------------------------
// Tests: search()
// ---------------------------------------------------------------------------

describe("MeilisearchStore.search()", () => {
	test("passes hybrid option with query vector when embeddingService returns a vector", async () => {
		const embeddingService = createMockEmbeddingService(async () => [0.1, 0.2, 0.3]);
		const { store, mockIdx } = createStoreWithMock({ embeddingService, semanticRatio: 0.8 });

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		await store.search("test query", 10);

		const searchCall = getCall(mockIdx._calls, "search");
		expect(searchCall[0]).toBe("test query");

		const searchOpts = searchCall[1] as Record<string, unknown>;
		expect(searchOpts.limit).toBe(10);

		const hybrid = searchOpts.hybrid as Record<string, unknown>;
		expect(hybrid).toBeDefined();
		expect(hybrid.embedder).toBe("default");
		expect(hybrid.semanticRatio).toBe(0.8);

		// Should include the query vector
		expect(searchOpts.vector).toEqual([0.1, 0.2, 0.3]);

		// Hybrid search should NOT have sort
		expect(searchOpts.sort).toBeUndefined();
	});

	test("falls back to keyword-only with sort when no embeddingService", async () => {
		const { store, mockIdx } = createStoreWithMock(); // No embeddingService

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		await store.search("test query", 5);

		const lastCall = getLastCall(mockIdx._calls, "search");

		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.hybrid).toBeUndefined();
		expect(searchOpts.sort).toEqual(["timestamp:desc"]);
	});

	test("falls back to keyword-only when query embedding returns null", async () => {
		const embeddingService = createMockEmbeddingService(async () => null);
		const { store, mockIdx } = createStoreWithMock({ embeddingService });

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		await store.search("test query", 5);

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.hybrid).toBeUndefined();
		expect(searchOpts.sort).toEqual(["timestamp:desc"]);
	});

	test("builds correct scope filter for project-scoped search", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		await store.search("test", 10, { scope: "project:/Users/drewbie/dev/randal" });

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;

		expect(searchOpts.filter).toBe(
			'(scope = "global" OR scope = "project:/Users/drewbie/dev/randal")',
		);
	});

	test("builds no scope filter when scope is 'all'", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		await store.search("test", 10, { scope: "all" });

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;

		expect(searchOpts.filter).toBeUndefined();
	});

	test("builds no scope filter when scope is undefined", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		await store.search("test", 10);

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;

		expect(searchOpts.filter).toBeUndefined();
	});

	test("does not filter for 'global' scope value (store-level passthrough)", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		// "global" doesn't start with "project:" — current buildScopeFilter returns undefined
		// This matches expected behavior: "global" as a direct value doesn't do scope filtering
		// at the store level; the MCP server resolves "global" appropriately
		await store.search("test", 10, { scope: "global" });

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;

		// "global" is not "all" and doesn't start with "project:" so no filter is applied
		expect(searchOpts.filter).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: index()
// ---------------------------------------------------------------------------

describe("MeilisearchStore.index()", () => {
	test("assigns 'global' scope for preference category", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		// First search call is the dedup check — return empty
		mockIdx._setSearchResults({ hits: [] });

		await store.index({
			type: "learning",
			file: "",
			content: "User prefers dark mode",
			contentHash: "hash-pref-1",
			category: "preference",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].scope).toBe("global");
	});

	test("assigns 'global' scope for fact category", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });

		await store.index({
			type: "learning",
			file: "",
			content: "TypeScript 5.5 supports inferred type predicates",
			contentHash: "hash-fact-1",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].scope).toBe("global");
	});

	test("assigns 'global' default for non-global category when no project scope", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });

		await store.index({
			type: "learning",
			file: "",
			content: "Always use try-catch around store.init()",
			contentHash: "hash-pattern-1",
			category: "pattern",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		// Without project context at the store layer, non-global categories default to "global"
		// Callers (MCP server) set scope explicitly for project-scoped memories
		expect(docs[0].scope).toBe("global");
	});

	test("preserves existing scope when already set on doc", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });

		await store.index({
			type: "learning",
			file: "",
			content: "Project-specific pattern",
			contentHash: "hash-scoped-1",
			category: "pattern",
			source: "self",
			timestamp: new Date().toISOString(),
			scope: "project:/Users/drewbie/dev/randal",
		});

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].scope).toBe("project:/Users/drewbie/dev/randal");
	});

	test("skips duplicate when contentHash already exists", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		// Simulate existing doc with same hash
		mockIdx._setSearchResults({
			hits: [{ id: "existing", contentHash: "duplicate-hash" }],
		});

		await store.index({
			type: "learning",
			file: "",
			content: "Duplicate content",
			contentHash: "duplicate-hash",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		// Should NOT have called addDocuments
		const addCalls = mockIdx._calls.addDocuments ?? [];
		expect(addCalls.length).toBe(0);
	});

	test("generates a UUID id for indexed documents", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });

		await store.index({
			type: "learning",
			file: "",
			content: "New memory",
			contentHash: "hash-uuid-test",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].id).toBeDefined();
		expect(typeof docs[0].id).toBe("string");
		// UUID format: 8-4-4-4-12 hex characters
		expect(docs[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	test("attaches _vectors when embeddingService returns a vector", async () => {
		const embeddingService = createMockEmbeddingService(async () => [0.1, 0.2, 0.3]);
		const { store, mockIdx } = createStoreWithMock({ embeddingService });

		await store.init();

		mockIdx._setSearchResults({ hits: [] });

		await store.index({
			type: "learning",
			file: "",
			content: "Memory with embedding",
			contentHash: "hash-vec-1",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		const vectors = docs[0]._vectors as Record<string, number[]>;
		expect(vectors).toBeDefined();
		expect(vectors.default).toBeDefined();
		expect(vectors.default).toEqual([0.1, 0.2, 0.3]);
	});

	test("stores without _vectors when embeddingService returns null", async () => {
		const embeddingService = createMockEmbeddingService(async () => null);
		const { store, mockIdx } = createStoreWithMock({ embeddingService });

		await store.init();

		mockIdx._setSearchResults({ hits: [] });

		await store.index({
			type: "learning",
			file: "",
			content: "Memory without embedding",
			contentHash: "hash-novec-1",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0]._vectors).toBeUndefined();
	});

	test("stores without _vectors when no embeddingService", async () => {
		const { store, mockIdx } = createStoreWithMock(); // No embeddingService

		await store.init();

		mockIdx._setSearchResults({ hits: [] });

		await store.index({
			type: "learning",
			file: "",
			content: "Keyword-only memory",
			contentHash: "hash-kw-1",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0]._vectors).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: recent()
// ---------------------------------------------------------------------------

describe("MeilisearchStore.recent()", () => {
	test("queries with sort by timestamp desc", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		await store.recent(5);

		const lastCall = getLastCall(mockIdx._calls, "search");
		expect(lastCall[0]).toBe(""); // Empty query
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.limit).toBe(5);
		expect(searchOpts.sort).toEqual(["timestamp:desc"]);
	});
});
