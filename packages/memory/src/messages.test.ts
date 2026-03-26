import { describe, expect, mock, test } from "bun:test";
import type { MessageDoc } from "@randal/core";
import { parseConfig } from "@randal/core";
import { MessageManager } from "./messages.js";
import type { MessageManagerOptions } from "./messages.js";

// ---------------------------------------------------------------------------
// Mock Meilisearch index
// ---------------------------------------------------------------------------

interface MockSearchResult {
	hits: Record<string, unknown>[];
}

function createMockIndex() {
	const calls: Record<string, unknown[][]> = {};

	function record(method: string, args: unknown[]) {
		if (!calls[method]) calls[method] = [];
		calls[method].push(args);
	}

	let searchResults: MockSearchResult = { hits: [] };

	const mockIndex = {
		update: mock(async (...args: unknown[]) => {
			record("update", args);
		}),
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
			return { taskUid: 1 };
		}),
		// Test helpers
		_calls: calls,
		_setSearchResults(results: MockSearchResult) {
			searchResults = results;
		},
	};

	return mockIndex;
}

function getCall(calls: Record<string, unknown[][]>, method: string, index = 0): unknown[] {
	const list = calls[method];
	if (!list || list.length <= index) {
		throw new Error(
			`Expected call ${method}[${index}] but only ${list?.length ?? 0} calls recorded`,
		);
	}
	return list[index];
}

function getLastCall(calls: Record<string, unknown[][]>, method: string): unknown[] {
	const list = calls[method];
	if (!list || list.length === 0) {
		throw new Error(`Expected at least one call to ${method}`);
	}
	return list[list.length - 1];
}

// ---------------------------------------------------------------------------
// Helper: create a MessageManager wired to a mock Meilisearch
// ---------------------------------------------------------------------------

function createManagerWithMock(overrides: Partial<MessageManagerOptions> = {}) {
	const config = parseConfig(`
name: test
runner:
  workdir: /tmp
`);

	const mockIdx = createMockIndex();

	const manager = new MessageManager({
		config,
		...overrides,
	});

	// Replace the internal client with one that returns our mock index.
	// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
	(manager as any).client = {
		index: () => mockIdx,
		createIndex: mock(async () => {}),
		waitForTask: mock(async () => {}),
	};

	return { manager, mockIdx };
}

/** Helper to make a minimal MessageDoc (without id — for add()). */
function makeMessage(overrides: Partial<Omit<MessageDoc, "id">> = {}): Omit<MessageDoc, "id"> {
	return {
		threadId: "thread-1",
		speaker: "user",
		channel: "opencode",
		content: "Hello world",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests: init()
// ---------------------------------------------------------------------------

describe("MessageManager.init()", () => {
	test("configures searchable, filterable, and sortable attributes", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		expect(mockIdx.updateSearchableAttributes).toHaveBeenCalledTimes(1);
		expect(mockIdx.updateFilterableAttributes).toHaveBeenCalledTimes(1);
		expect(mockIdx.updateSortableAttributes).toHaveBeenCalledTimes(1);

		// Verify filterable includes scope and type
		const filterableCall = getCall(mockIdx._calls, "updateFilterableAttributes");
		const attrs = filterableCall[0] as string[];
		expect(attrs).toContain("scope");
		expect(attrs).toContain("type");
		expect(attrs).toContain("threadId");
	});

	test("configures embedder when provided with API key", async () => {
		const { manager, mockIdx } = createManagerWithMock({
			embedder: {
				type: "openrouter",
				apiKey: "sk-or-test-key",
				model: "openai/text-embedding-3-small",
				url: "https://openrouter.ai/api/v1/embeddings",
			},
		});

		await manager.init();

		expect(mockIdx.updateEmbedders).toHaveBeenCalledTimes(1);

		const embedderCall = getCall(mockIdx._calls, "updateEmbedders");
		const embeddersArg = embedderCall[0] as Record<string, unknown>;
		const chatEmbedder = embeddersArg["chat-embedder"] as Record<string, unknown>;
		expect(chatEmbedder).toBeDefined();
		expect(chatEmbedder.source).toBe("rest");
		expect(chatEmbedder.apiKey).toBe("sk-or-test-key");
	});

	test("skips embedder when not provided (backward compat)", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		expect(mockIdx.updateEmbedders).toHaveBeenCalledTimes(0);
	});

	test("skips embedder when API key is empty", async () => {
		const { manager, mockIdx } = createManagerWithMock({
			embedder: {
				type: "openrouter",
				apiKey: "",
				model: "openai/text-embedding-3-small",
			},
		});

		await manager.init();

		expect(mockIdx.updateEmbedders).toHaveBeenCalledTimes(0);
	});

	test("falls back gracefully when updateEmbedders throws", async () => {
		const { manager, mockIdx } = createManagerWithMock({
			embedder: {
				type: "openrouter",
				apiKey: "sk-or-test-key",
				model: "openai/text-embedding-3-small",
			},
		});

		mockIdx.updateEmbedders.mockImplementation(async () => {
			throw new Error("Embedder configuration failed");
		});

		// Should NOT throw
		await manager.init();

		// Semantic should be unavailable — verified in search tests
	});
});

// ---------------------------------------------------------------------------
// Tests: search()
// ---------------------------------------------------------------------------

describe("MessageManager.search()", () => {
	test("uses hybrid mode when semantic is available", async () => {
		const { manager, mockIdx } = createManagerWithMock({
			embedder: {
				type: "openrouter",
				apiKey: "sk-or-test-key",
				model: "openai/text-embedding-3-small",
			},
			semanticRatio: 0.8,
		});

		await manager.init(); // Enables semantic

		mockIdx._setSearchResults({ hits: [] });
		await manager.search("authentication flow", 10);

		const lastCall = getLastCall(mockIdx._calls, "search");
		expect(lastCall[0]).toBe("authentication flow");

		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.limit).toBe(10);

		const hybrid = searchOpts.hybrid as Record<string, unknown>;
		expect(hybrid).toBeDefined();
		expect(hybrid.embedder).toBe("chat-embedder");
		expect(hybrid.semanticRatio).toBe(0.8);

		// Hybrid search should NOT have sort
		expect(searchOpts.sort).toBeUndefined();
	});

	test("falls back to keyword+sort when semantic unavailable", async () => {
		const { manager, mockIdx } = createManagerWithMock(); // No embedder

		await manager.init();

		mockIdx._setSearchResults({ hits: [] });
		await manager.search("test query", 5);

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.hybrid).toBeUndefined();
		expect(searchOpts.sort).toEqual(["timestamp:desc"]);
	});

	test("falls back to keyword when embedder init failed", async () => {
		const { manager, mockIdx } = createManagerWithMock({
			embedder: {
				type: "openrouter",
				apiKey: "sk-or-test-key",
				model: "openai/text-embedding-3-small",
			},
		});

		mockIdx.updateEmbedders.mockImplementation(async () => {
			throw new Error("Embedder unavailable");
		});

		await manager.init();

		mockIdx._setSearchResults({ hits: [] });
		await manager.search("test query", 5);

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.hybrid).toBeUndefined();
		expect(searchOpts.sort).toEqual(["timestamp:desc"]);
	});

	test("applies scope filter correctly", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		mockIdx._setSearchResults({ hits: [] });
		await manager.search("test", 10, {
			scope: "project:/Users/drewbie/dev/randal",
		});

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.filter).toBe('scope = "project:/Users/drewbie/dev/randal"');
	});

	test("applies type filter correctly", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		mockIdx._setSearchResults({ hits: [] });
		await manager.search("test", 10, { type: "summary" });

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.filter).toBe('type = "summary"');
	});

	test("combines scope and type filters with AND", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		mockIdx._setSearchResults({ hits: [] });
		await manager.search("test", 10, {
			scope: "project:/my/repo",
			type: "message",
		});

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.filter).toBe('scope = "project:/my/repo" AND type = "message"');
	});

	test("no filter when no options provided", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		mockIdx._setSearchResults({ hits: [] });
		await manager.search("test", 10);

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.filter).toBeUndefined();
	});

	test("returns hits from Meilisearch", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		const fakeHits = [
			{
				id: "msg-1",
				threadId: "thread-1",
				speaker: "user",
				channel: "opencode",
				content: "Discuss auth flow",
				timestamp: "2026-03-26T00:00:00Z",
			},
		];
		mockIdx._setSearchResults({ hits: fakeHits });

		const results = await manager.search("auth", 10);
		expect(results).toHaveLength(1);
		expect((results[0] as unknown as Record<string, unknown>).content).toBe("Discuss auth flow");
	});
});

// ---------------------------------------------------------------------------
// Tests: add() and auto-summary
// ---------------------------------------------------------------------------

describe("MessageManager.add()", () => {
	test("returns a UUID id", async () => {
		const { manager } = createManagerWithMock();
		await manager.init();

		const id = await manager.add(makeMessage());

		expect(id).toBeDefined();
		expect(typeof id).toBe("string");
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	test("calls addDocuments on the index", async () => {
		const { manager, mockIdx } = createManagerWithMock();
		await manager.init();

		await manager.add(makeMessage({ content: "Store this" }));

		const addCall = getCall(mockIdx._calls, "addDocuments");
		const docs = addCall[0] as Record<string, unknown>[];
		expect(docs).toHaveLength(1);
		expect(docs[0].content).toBe("Store this");
	});

	test("increments thread counter and triggers summary at threshold", async () => {
		const summaryGenerate = mock(async () => ({
			summary: "Test summary",
			topicKeywords: ["test"],
		}));

		const { manager, mockIdx } = createManagerWithMock({
			summaryThreshold: 3, // Low threshold for testing
			summaryGenerator: {
				apiKey: "test-key",
			},
		});

		// Replace the internal summaryGenerator to use our mock
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		(manager as any).summaryGenerator = { generate: summaryGenerate };

		await manager.init();

		// thread() returns results from search — set up what it will return
		mockIdx._setSearchResults({
			hits: [
				{
					id: "msg-1",
					threadId: "thread-1",
					speaker: "user",
					channel: "opencode",
					content: "Message 1",
					timestamp: "2026-03-26T00:00:00Z",
				},
				{
					id: "msg-2",
					threadId: "thread-1",
					speaker: "randal",
					channel: "opencode",
					content: "Message 2",
					timestamp: "2026-03-26T00:00:01Z",
				},
				{
					id: "msg-3",
					threadId: "thread-1",
					speaker: "user",
					channel: "opencode",
					content: "Message 3",
					timestamp: "2026-03-26T00:00:02Z",
				},
			],
		});

		// Add messages until threshold is reached
		await manager.add(makeMessage({ threadId: "thread-1", content: "m1" }));
		await manager.add(makeMessage({ threadId: "thread-1", content: "m2" }));

		// Should not have triggered yet
		expect(summaryGenerate).toHaveBeenCalledTimes(0);

		// Third message triggers summary (threshold = 3)
		await manager.add(makeMessage({ threadId: "thread-1", content: "m3" }));

		// Fire-and-forget — give it a tick to resolve
		await new Promise((r) => setTimeout(r, 50));

		expect(summaryGenerate).toHaveBeenCalledTimes(1);
	});

	test("doesn't block on summary generation (fire-and-forget)", async () => {
		// Summary takes a long time
		const slowGenerate = mock(
			async () =>
				new Promise<{ summary: string; topicKeywords: string[] }>((resolve) =>
					setTimeout(
						() =>
							resolve({
								summary: "slow summary",
								topicKeywords: [],
							}),
						500,
					),
				),
		);

		const { manager, mockIdx } = createManagerWithMock({
			summaryThreshold: 1, // Trigger immediately
			summaryGenerator: { apiKey: "test-key" },
		});

		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		(manager as any).summaryGenerator = { generate: slowGenerate };

		await manager.init();

		mockIdx._setSearchResults({
			hits: [
				{
					id: "msg-1",
					threadId: "thread-1",
					speaker: "user",
					content: "msg",
					channel: "opencode",
					timestamp: new Date().toISOString(),
				},
			],
		});

		const start = Date.now();
		await manager.add(makeMessage({ threadId: "thread-1", content: "trigger" }));
		const elapsed = Date.now() - start;

		// add() should return near-instantly, NOT wait 500ms for summary
		expect(elapsed).toBeLessThan(200);
	});

	test("doesn't trigger summary for summary-type docs", async () => {
		const summaryGenerate = mock(async () => ({
			summary: "Test summary",
			topicKeywords: ["test"],
		}));

		const { manager, mockIdx } = createManagerWithMock({
			summaryThreshold: 1, // Would trigger immediately for regular messages
			summaryGenerator: { apiKey: "test-key" },
		});

		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		(manager as any).summaryGenerator = { generate: summaryGenerate };

		await manager.init();

		// Adding a summary doc should not trigger another summary
		await manager.add(
			makeMessage({
				threadId: "thread-1",
				type: "summary",
				content: "existing summary",
			}),
		);

		await new Promise((r) => setTimeout(r, 50));

		expect(summaryGenerate).toHaveBeenCalledTimes(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: endSession()
// ---------------------------------------------------------------------------

describe("MessageManager.endSession()", () => {
	test("generates final summary from thread messages", async () => {
		const summaryGenerate = mock(async () => ({
			summary: "Final summary",
			topicKeywords: ["final"],
		}));

		const { manager, mockIdx } = createManagerWithMock({
			summaryGenerator: { apiKey: "test-key" },
		});

		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		(manager as any).summaryGenerator = { generate: summaryGenerate };

		await manager.init();

		mockIdx._setSearchResults({
			hits: [
				{
					id: "msg-1",
					threadId: "thread-1",
					speaker: "user",
					channel: "opencode",
					content: "Let's discuss auth",
					timestamp: "2026-03-26T00:00:00Z",
				},
				{
					id: "msg-2",
					threadId: "thread-1",
					speaker: "randal",
					channel: "opencode",
					content: "Sure, auth requires tokens",
					timestamp: "2026-03-26T00:00:01Z",
				},
			],
		});

		await manager.endSession("thread-1");

		expect(summaryGenerate).toHaveBeenCalledTimes(1);
	});

	test("skips summary when no generator configured", async () => {
		const { manager, mockIdx } = createManagerWithMock(); // No summaryGenerator

		await manager.init();

		// Should not throw
		await manager.endSession("thread-1");

		// No search should even happen since we bail early
		const searchCalls = mockIdx._calls.search ?? [];
		expect(searchCalls.length).toBe(0);
	});

	test("cleans up thread message counter", async () => {
		const summaryGenerate = mock(async () => ({
			summary: "Summary",
			topicKeywords: [],
		}));

		const { manager, mockIdx } = createManagerWithMock({
			summaryThreshold: 100,
			summaryGenerator: { apiKey: "test-key" },
		});

		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		(manager as any).summaryGenerator = { generate: summaryGenerate };

		await manager.init();

		// Add some messages to build up counter
		await manager.add(makeMessage({ threadId: "thread-1" }));
		await manager.add(makeMessage({ threadId: "thread-1" }));

		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
		const counters = (manager as any).threadMessageCounts as Map<string, number>;
		expect(counters.get("thread-1")).toBe(2);

		mockIdx._setSearchResults({ hits: [] }); // Empty thread for endSession

		await manager.endSession("thread-1");

		expect(counters.has("thread-1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: thread()
// ---------------------------------------------------------------------------

describe("MessageManager.thread()", () => {
	test("returns messages in chronological order (sort: asc)", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		mockIdx._setSearchResults({
			hits: [
				{
					id: "msg-1",
					threadId: "t-1",
					content: "First",
					timestamp: "2026-03-26T00:00:00Z",
				},
				{
					id: "msg-2",
					threadId: "t-1",
					content: "Second",
					timestamp: "2026-03-26T00:01:00Z",
				},
			],
		});

		const results = await manager.thread("t-1");

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.sort).toEqual(["timestamp:asc"]);
		expect(searchOpts.filter).toBe('threadId = "t-1"');
		expect(results).toHaveLength(2);
	});

	test("respects limit parameter", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		mockIdx._setSearchResults({ hits: [] });
		await manager.thread("t-1", 25);

		const lastCall = getLastCall(mockIdx._calls, "search");
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.limit).toBe(25);
	});
});

// ---------------------------------------------------------------------------
// Tests: recent()
// ---------------------------------------------------------------------------

describe("MessageManager.recent()", () => {
	test("returns most recent messages (sort: desc)", async () => {
		const { manager, mockIdx } = createManagerWithMock();

		await manager.init();

		mockIdx._setSearchResults({
			hits: [
				{
					id: "msg-2",
					content: "Latest",
					timestamp: "2026-03-26T01:00:00Z",
				},
				{
					id: "msg-1",
					content: "Earlier",
					timestamp: "2026-03-26T00:00:00Z",
				},
			],
		});

		const results = await manager.recent(10);

		const lastCall = getLastCall(mockIdx._calls, "search");
		expect(lastCall[0]).toBe(""); // Empty query
		const searchOpts = lastCall[1] as Record<string, unknown>;
		expect(searchOpts.sort).toEqual(["timestamp:desc"]);
		expect(searchOpts.limit).toBe(10);
		expect(results).toHaveLength(2);
	});
});
