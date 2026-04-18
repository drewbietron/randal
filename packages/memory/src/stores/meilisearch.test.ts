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
		url: "http://localhost:7701",
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

	test("assigns 'unscoped' default for non-global category when no project scope", async () => {
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
		// Without project context at the store layer, non-global categories get "unscoped".
		// Callers (MCP server) set scope explicitly for project-scoped memories.
		expect(docs[0].scope).toBe("unscoped");
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

// ---------------------------------------------------------------------------
// Tests: Retry behavior (Steps 2-3)
// ---------------------------------------------------------------------------

function makeDoc(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		type: "learning" as const,
		file: "",
		content: "test content",
		contentHash: `hash-${Date.now()}-${Math.random()}`,
		category: "fact" as const,
		source: "self" as const,
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

describe("MeilisearchStore.index() — retry behavior", () => {
	test("returns { status: 'success' } on first attempt success", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		const result = await store.index(makeDoc());

		expect(result).toEqual({ status: "success" });
		expect(mockIdx.addDocuments).toHaveBeenCalledTimes(1);
	});

	test("retries on failure and succeeds on third attempt", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		let callCount = 0;
		mockIdx.addDocuments.mockImplementation(async () => {
			callCount++;
			if (callCount < 3) throw new Error(`Attempt ${callCount} failed`);
		});

		const result = await store.index(makeDoc());

		expect(result).toEqual({ status: "success" });
		expect(callCount).toBe(3);
	});

	test("queues document when all retries exhausted", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		mockIdx.addDocuments.mockImplementation(async () => {
			throw new Error("Connection refused");
		});

		const result = await store.index(makeDoc());

		expect(result.status).toBe("queued");
		if (result.status === "queued") {
			expect(result.reason).toContain("Connection refused");
		}
		expect(store.pendingWrites).toBe(1);
	});

	test("returns { status: 'duplicate' } when contentHash already exists", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();

		mockIdx._setSearchResults({
			hits: [{ id: "existing", contentHash: "known-hash" }],
		});

		const result = await store.index(makeDoc({ contentHash: "known-hash" }));

		expect(result).toEqual({ status: "duplicate", contentHash: "known-hash" });
		// addDocuments should NOT have been called
		expect(mockIdx._calls.addDocuments ?? []).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: Write-ahead queue (Step 3)
// ---------------------------------------------------------------------------

describe("MeilisearchStore — write-ahead queue", () => {
	test("drains queued writes on next successful index()", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		// First call: always fail → queued
		mockIdx.addDocuments.mockImplementation(async () => {
			throw new Error("Meili down");
		});
		await store.index(makeDoc({ contentHash: "queued-doc-1" }));
		expect(store.pendingWrites).toBe(1);

		// Second call: succeed → should also drain the queue
		mockIdx.addDocuments.mockImplementation(async () => {
			// success
		});
		await store.index(makeDoc({ contentHash: "success-doc-1" }));

		// Give the fire-and-forget drain a tick to complete
		await new Promise((r) => setTimeout(r, 50));

		expect(store.pendingWrites).toBe(0);
	});

	test("returns { status: 'failed' } when queue is full", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		// Directly populate the write queue to MAX_QUEUE_SIZE to avoid
		// calling index() 100 times with retry delays
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		const maxSize = (MeilisearchStore as any).MAX_QUEUE_SIZE as number;
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		const queue = (store as any).writeQueue as Array<{
			doc: Record<string, unknown>;
			queuedAt: number;
		}>;
		for (let i = 0; i < maxSize; i++) {
			queue.push({ doc: { id: `queued-${i}` }, queuedAt: Date.now() });
		}
		expect(store.pendingWrites).toBe(maxSize);

		// Now make addDocuments fail so the next index() exhausts retries
		mockIdx.addDocuments.mockImplementation(async () => {
			throw new Error("Meili down");
		});

		const result = await store.index(makeDoc({ contentHash: "overflow" }));
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error).toContain("Write queue full");
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: Health check (Steps 4-5)
// ---------------------------------------------------------------------------

describe("MeilisearchStore — health monitoring", () => {
	test("isHealthy() returns true after successful init()", async () => {
		const { store } = createStoreWithMock();
		await store.init();

		expect(store.isHealthy()).toBe(true);

		store.destroy(); // cleanup timer
	});

	test("isHealthy() returns false before init()", () => {
		const { store } = createStoreWithMock();

		expect(store.isHealthy()).toBe(false);
	});

	test("destroy() stops health check interval", async () => {
		const { store } = createStoreWithMock();
		await store.init();

		store.destroy();

		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		expect((store as any).healthCheckInterval).toBeNull();
	});

	test("checkHealth() sets healthy=false when fetch fails", async () => {
		const { store } = createStoreWithMock();
		await store.init();
		expect(store.isHealthy()).toBe(true);

		// Override global fetch for this test
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error("ECONNREFUSED");
		};

		try {
			// biome-ignore lint/suspicious/noExplicitAny: test-only access to private method
			await (store as any).checkHealth();
			expect(store.isHealthy()).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
			store.destroy();
		}
	});

	test("checkHealth() sets healthy=true when fetch returns 200", async () => {
		const { store } = createStoreWithMock();
		await store.init();

		// Force unhealthy state
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		(store as any).healthy = false;
		expect(store.isHealthy()).toBe(false);

		// Mock fetch to return healthy
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ status: "available" }), { status: 200 });

		try {
			// biome-ignore lint/suspicious/noExplicitAny: test-only access to private method
			await (store as any).checkHealth();
			expect(store.isHealthy()).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
			store.destroy();
		}
	});

	test("checkHealth() calls reInit() on unhealthy→healthy transition", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();

		// Force unhealthy state
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		(store as any).healthy = false;

		// Reset call counts to track reInit activity
		mockIdx.updateSearchableAttributes.mockClear();
		mockIdx.updateFilterableAttributes.mockClear();
		mockIdx.updateSortableAttributes.mockClear();

		// Mock fetch to return healthy
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ status: "available" }), { status: 200 });

		try {
			// biome-ignore lint/suspicious/noExplicitAny: test-only access to private method
			await (store as any).checkHealth();

			// reInit() should have reconfigured indexes
			expect(mockIdx.updateSearchableAttributes).toHaveBeenCalledTimes(1);
			expect(mockIdx.updateFilterableAttributes).toHaveBeenCalledTimes(1);
			expect(mockIdx.updateSortableAttributes).toHaveBeenCalledTimes(1);
		} finally {
			globalThis.fetch = originalFetch;
			store.destroy();
		}
	});

	test("checkHealth() does NOT call reInit() on healthy→healthy (no transition)", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		expect(store.isHealthy()).toBe(true);

		// Reset call counts
		mockIdx.updateSearchableAttributes.mockClear();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ status: "available" }), { status: 200 });

		try {
			// biome-ignore lint/suspicious/noExplicitAny: test-only access to private method
			await (store as any).checkHealth();

			// No reInit — already healthy
			expect(mockIdx.updateSearchableAttributes).toHaveBeenCalledTimes(0);
		} finally {
			globalThis.fetch = originalFetch;
			store.destroy();
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: Scope defaults (Step 6)
// ---------------------------------------------------------------------------

describe("MeilisearchStore — scope defaults", () => {
	test("'preference' category gets scope 'global'", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		await store.index(makeDoc({ category: "preference" }));

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].scope).toBe("global");
	});

	test("'fact' category gets scope 'global'", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		await store.index(makeDoc({ category: "fact" }));

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].scope).toBe("global");
	});

	test("'pattern' category gets scope 'unscoped' (not 'global')", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		await store.index(makeDoc({ category: "pattern" }));

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].scope).toBe("unscoped");
	});

	test("'lesson' category gets scope 'unscoped' (not 'global')", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		await store.index(makeDoc({ category: "lesson" }));

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].scope).toBe("unscoped");
	});

	test("explicit scope is preserved regardless of category", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		await store.index(makeDoc({ category: "pattern", scope: "project:/my/project" }));

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs[0].scope).toBe("project:/my/project");
	});
});

// ---------------------------------------------------------------------------
// Tests: IndexResult propagation (Step 9)
// ---------------------------------------------------------------------------

describe("MeilisearchStore.index() — IndexResult status codes", () => {
	test("returns 'success' on normal write", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		const result = await store.index(makeDoc());
		expect(result.status).toBe("success");
	});

	test("returns 'duplicate' with contentHash when dedup detects existing", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [{ id: "x", contentHash: "abc123" }] });

		const result = await store.index(makeDoc({ contentHash: "abc123" }));
		expect(result).toEqual({ status: "duplicate", contentHash: "abc123" });
	});

	test("returns 'queued' with reason when retries exhausted but queue has space", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });
		mockIdx.addDocuments.mockImplementation(async () => {
			throw new Error("timeout");
		});

		const result = await store.index(makeDoc());
		expect(result.status).toBe("queued");
		if (result.status === "queued") {
			expect(result.reason).toBe("timeout");
		}
	});

	test("returns 'failed' with error when retries exhausted and queue full", async () => {
		const { store, mockIdx } = createStoreWithMock();
		await store.init();
		mockIdx._setSearchResults({ hits: [] });

		// Directly fill the queue to avoid retry delays
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		const maxSize = (MeilisearchStore as any).MAX_QUEUE_SIZE as number;
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		const queue = (store as any).writeQueue as Array<{
			doc: Record<string, unknown>;
			queuedAt: number;
		}>;
		for (let i = 0; i < maxSize; i++) {
			queue.push({ doc: { id: `queued-${i}` }, queuedAt: Date.now() });
		}

		mockIdx.addDocuments.mockImplementation(async () => {
			throw new Error("down");
		});

		const result = await store.index(makeDoc({ contentHash: "overflow" }));
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error).toContain("Write queue full");
		}
	});
});
