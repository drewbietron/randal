import { describe, expect, mock, test } from "bun:test";
import { MeilisearchStore } from "./meilisearch.js";
import type { EmbedderConfig } from "./meilisearch.js";

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
function getCall(
	calls: Record<string, unknown[][]>,
	method: string,
	index = 0,
): unknown[] {
	const list = calls[method];
	if (!list || list.length <= index) {
		throw new Error(`Expected call ${method}[${index}] but only ${list?.length ?? 0} calls recorded`);
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
 * Creates a MeilisearchStore that uses our mock index instead of connecting
 * to a real Meilisearch instance. Achieves this by replacing the internal
 * client's `index()` method after construction.
 */
function createStoreWithMock(
	options: {
		embedder?: EmbedderConfig;
		semanticRatio?: number;
	} = {},
) {
	const store = new MeilisearchStore({
		url: "http://localhost:7700",
		apiKey: "test-key",
		index: "test-index",
		embedder: options.embedder,
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

	test("calls updateEmbedders with correct REST config when embedder is provided", async () => {
		const embedder: EmbedderConfig = {
			type: "openrouter",
			apiKey: "sk-or-test-key",
			model: "openai/text-embedding-3-small",
			url: "https://openrouter.ai/api/v1/embeddings",
		};

		const { store, mockIdx } = createStoreWithMock({ embedder });

		await store.init();

		expect(mockIdx.updateEmbedders).toHaveBeenCalledTimes(1);

		const embedderCall = getCall(mockIdx._calls, "updateEmbedders");
		const embeddersArg = embedderCall[0] as Record<string, unknown>;
		expect(embeddersArg).toBeDefined();

		// Should have a "memory-embedder" key
		const embedderConfig = embeddersArg["memory-embedder"] as Record<string, unknown>;
		expect(embedderConfig).toBeDefined();
		expect(embedderConfig.source).toBe("rest");
		expect(embedderConfig.url).toBe("https://openrouter.ai/api/v1/embeddings");
		expect(embedderConfig.apiKey).toBe("sk-or-test-key");

		const request = embedderConfig.request as Record<string, unknown>;
		expect(request.model).toBe("openai/text-embedding-3-small");
	});

	test("skips updateEmbedders when no embedder config", async () => {
		const { store, mockIdx } = createStoreWithMock();

		await store.init();

		expect(mockIdx.updateEmbedders).toHaveBeenCalledTimes(0);
	});

	test("skips updateEmbedders when embedder has no API key", async () => {
		const embedder: EmbedderConfig = {
			type: "openrouter",
			apiKey: "",
			model: "openai/text-embedding-3-small",
		};

		const { store, mockIdx } = createStoreWithMock({ embedder });

		await store.init();

		expect(mockIdx.updateEmbedders).toHaveBeenCalledTimes(0);
	});

	test("falls back gracefully when updateEmbedders throws", async () => {
		const embedder: EmbedderConfig = {
			type: "openrouter",
			apiKey: "sk-or-test-key",
			model: "openai/text-embedding-3-small",
		};

		const { store, mockIdx } = createStoreWithMock({ embedder });

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
	test("passes hybrid option when semantic is available", async () => {
		const embedder: EmbedderConfig = {
			type: "openrouter",
			apiKey: "sk-or-test-key",
			model: "openai/text-embedding-3-small",
		};

		const { store, mockIdx } = createStoreWithMock({ embedder, semanticRatio: 0.8 });

		await store.init(); // Enables semantic

		mockIdx._setSearchResults({ hits: [] });
		await store.search("test query", 10);

		const searchCall = getCall(mockIdx._calls, "search");
		expect(searchCall[0]).toBe("test query");

		const searchOpts = searchCall[1] as Record<string, unknown>;
		expect(searchOpts.limit).toBe(10);

		const hybrid = searchOpts.hybrid as Record<string, unknown>;
		expect(hybrid).toBeDefined();
		expect(hybrid.embedder).toBe("memory-embedder");
		expect(hybrid.semanticRatio).toBe(0.8);

		// Hybrid search should NOT have sort
		expect(searchOpts.sort).toBeUndefined();
	});

	test("falls back to keyword-only with sort when semantic unavailable", async () => {
		const { store, mockIdx } = createStoreWithMock(); // No embedder

		await store.init();

		mockIdx._setSearchResults({ hits: [] });
		await store.search("test query", 5);

		const lastCall = getLastCall(mockIdx._calls, "search");

		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.hybrid).toBeUndefined();
		expect(searchOpts.sort).toEqual(["timestamp:desc"]);
	});

	test("falls back to keyword-only when embedder init failed", async () => {
		const embedder: EmbedderConfig = {
			type: "openrouter",
			apiKey: "sk-or-test-key",
			model: "openai/text-embedding-3-small",
		};

		const { store, mockIdx } = createStoreWithMock({ embedder });

		// Make embedder config fail
		mockIdx.updateEmbedders.mockImplementation(async () => {
			throw new Error("Embedder unavailable");
		});

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
		expect(docs[0].id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
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
