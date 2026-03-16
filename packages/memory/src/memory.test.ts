import { describe, expect, test } from "bun:test";
import type { MemoryDoc } from "@randal/core";
import { parseConfig } from "@randal/core";
import type { StoreFactory } from "./cross-agent.js";
import { MemoryManager } from "./memory.js";
import type { MemoryStore } from "./stores/index.js";

/**
 * In-memory mock store for testing MemoryManager without Meilisearch.
 */
class MockStore implements MemoryStore {
	private docs: MemoryDoc[] = [];

	async init(): Promise<void> {}

	async search(query: string, limit: number): Promise<MemoryDoc[]> {
		const lower = query.toLowerCase();
		return this.docs.filter((d) => d.content.toLowerCase().includes(lower)).slice(0, limit);
	}

	async index(doc: Omit<MemoryDoc, "id">): Promise<void> {
		this.docs.push({ ...doc, id: `mock-${Date.now()}-${Math.random()}` });
	}

	async recent(limit: number): Promise<MemoryDoc[]> {
		return this.docs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
	}

	getDocs(): MemoryDoc[] {
		return [...this.docs];
	}
}

describe("MemoryManager (config defaults)", () => {
	test("constructor creates MeilisearchStore with config defaults", () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
`);
		// Verify memory config defaults
		expect(config.memory.url).toBe("http://localhost:7700");
		expect(config.memory.apiKey).toBe("");
	});

	test("config accepts store field with file value", () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
memory:
  store: file
`);
		expect(config.memory.store).toBe("file");
		expect(config.memory.url).toBe("http://localhost:7700");
	});

	test("config defaults store to meilisearch", () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
`);
		expect(config.memory.store).toBe("meilisearch");
	});

	test("config accepts explicit meilisearch url/apiKey", () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
memory:
  url: http://custom:7700
  apiKey: my-key
  index: custom-index
`);
		expect(config.memory.url).toBe("http://custom:7700");
		expect(config.memory.apiKey).toBe("my-key");
		expect(config.memory.index).toBe("custom-index");
	});
});

describe("MemoryManager (with mock store)", () => {
	function makeManager(
		options: {
			readFrom?: string[];
			publishTo?: string;
			crossStores?: Map<string, MemoryStore>;
		} = {},
	) {
		const publishLine = options.publishTo ? `\n    publishTo: "${options.publishTo}"` : "";
		const readLine =
			(options.readFrom ?? []).length > 0
				? `\n    readFrom: [${(options.readFrom ?? []).map((s) => `"${s}"`).join(", ")}]`
				: "\n    readFrom: []";

		const config = parseConfig(`
name: test-agent
runner:
  workdir: /tmp
memory:
  store: file
  url: http://localhost:7700
  apiKey: test
  sharing:${publishLine}${readLine}
  autoInject:
    maxResults: 5
`);

		const ownStore = new MockStore();

		const crossStores = options.crossStores ?? new Map();
		const storeFactory: StoreFactory = (opts) => {
			return crossStores.get(opts.index) ?? new MockStore();
		};

		const mgr = new MemoryManager({
			config,
			store: ownStore,
			storeFactory,
		});

		return { mgr, ownStore, crossStores };
	}

	test("search returns results from own store", async () => {
		const { mgr, ownStore } = makeManager();
		await ownStore.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Test learning about APIs",
			contentHash: "hash1",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const results = await mgr.search("APIs");
		expect(results).toHaveLength(1);
		expect(results[0].content).toBe("Test learning about APIs");
	});

	test("index stores doc in own store", async () => {
		const { mgr, ownStore } = makeManager();
		await mgr.index({
			type: "learning",
			file: "MEMORY.md",
			content: "New learning",
			contentHash: "hash2",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const docs = ownStore.getDocs();
		expect(docs).toHaveLength(1);
		expect(docs[0].content).toBe("New learning");
	});

	test("index also publishes to shared index when publishTo configured", async () => {
		const sharedStore = new MockStore();
		const crossStores = new Map<string, MemoryStore>();
		crossStores.set("shared-team", sharedStore);

		const { mgr } = makeManager({
			publishTo: "shared-team",
			crossStores,
		});

		await mgr.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Shared learning",
			contentHash: "hash3",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const sharedDocs = sharedStore.getDocs();
		expect(sharedDocs).toHaveLength(1);
		expect(sharedDocs[0].content).toBe("Shared learning");
	});

	test("index does not publish when publishTo is empty", async () => {
		const sharedStore = new MockStore();
		const crossStores = new Map<string, MemoryStore>();
		crossStores.set("shared-team", sharedStore);

		const { mgr } = makeManager({ crossStores });

		await mgr.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Private learning",
			contentHash: "hash4",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const sharedDocs = sharedStore.getDocs();
		expect(sharedDocs).toHaveLength(0);
	});

	test("searchForContext returns formatted strings without sharing", async () => {
		const { mgr, ownStore } = makeManager();
		await ownStore.index({
			type: "learning",
			file: "MEMORY.md",
			content: "API patterns are important",
			contentHash: "hash5",
			category: "pattern",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const context = await mgr.searchForContext("API");
		expect(context).toHaveLength(1);
		expect(context[0]).toBe("[pattern] API patterns are important");
	});

	test("searchForContext merges cross-agent results when readFrom configured", async () => {
		const sharedStore = new MockStore();
		await sharedStore.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Cross-agent API pattern",
			contentHash: "hash-cross",
			category: "pattern",
			source: "agent:ops" as MemoryDoc["source"],
			timestamp: "2025-01-01T00:00:00Z",
		});

		const crossStores = new Map<string, MemoryStore>();
		crossStores.set("shared-team", sharedStore);

		const { mgr, ownStore } = makeManager({
			readFrom: ["shared-team"],
			crossStores,
		});

		await ownStore.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Own API learning",
			contentHash: "hash-own",
			category: "fact",
			source: "self",
			timestamp: "2025-06-01T00:00:00Z",
		});

		const context = await mgr.searchForContext("API");
		expect(context).toHaveLength(2);
		// Own results are formatted without agent attribution
		expect(context.some((c) => c === "[fact] Own API learning")).toBe(true);
		// Cross-agent results include agent attribution (R1.8)
		expect(context.some((c) => c.includes("(from agent:ops)"))).toBe(true);
	});

	test("searchForContext deduplicates by contentHash", async () => {
		const sharedStore = new MockStore();
		await sharedStore.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Duplicated learning",
			contentHash: "same-hash",
			category: "fact",
			source: "agent:ops" as MemoryDoc["source"],
			timestamp: "2025-01-01T00:00:00Z",
		});

		const crossStores = new Map<string, MemoryStore>();
		crossStores.set("shared-team", sharedStore);

		const { mgr, ownStore } = makeManager({
			readFrom: ["shared-team"],
			crossStores,
		});

		await ownStore.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Duplicated learning",
			contentHash: "same-hash",
			category: "fact",
			source: "self",
			timestamp: "2025-06-01T00:00:00Z",
		});

		const context = await mgr.searchForContext("Duplicated");
		// Should be deduplicated - only one result
		expect(context).toHaveLength(1);
	});

	test("searchForContext caps merged results at maxResults", async () => {
		const sharedStore = new MockStore();
		for (let i = 0; i < 10; i++) {
			await sharedStore.index({
				type: "learning",
				file: "MEMORY.md",
				content: `Cross learning ${i}`,
				contentHash: `hash-cross-${i}`,
				category: "fact",
				source: "agent:ops" as MemoryDoc["source"],
				timestamp: new Date(2025, 0, i + 1).toISOString(),
			});
		}

		const crossStores = new Map<string, MemoryStore>();
		crossStores.set("shared-team", sharedStore);

		const { mgr } = makeManager({
			readFrom: ["shared-team"],
			crossStores,
		});

		const context = await mgr.searchForContext("learning");
		// maxResults is 5 in our config
		expect(context.length).toBeLessThanOrEqual(5);
	});

	test("searchForContext behaves identically without sharing (R1.7)", async () => {
		const { mgr, ownStore } = makeManager({ readFrom: [] });
		await ownStore.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Normal learning",
			contentHash: "hash-normal",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const context = await mgr.searchForContext("Normal");
		expect(context).toHaveLength(1);
		expect(context[0]).toBe("[fact] Normal learning");
	});

	test("recent returns recent docs from own store", async () => {
		const { mgr, ownStore } = makeManager();
		await ownStore.index({
			type: "learning",
			file: "MEMORY.md",
			content: "Recent thing",
			contentHash: "hash-recent",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const recent = await mgr.recent(5);
		expect(recent).toHaveLength(1);
		expect(recent[0].content).toBe("Recent thing");
	});
});
