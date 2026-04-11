import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryDoc } from "@randal/core";
import { parseConfig } from "@randal/core";
import type { StoreFactory } from "@randal/memory";
import { MemoryManager } from "@randal/memory";
import type { MemoryStore } from "../../packages/memory/src/stores/index.js";

/**
 * Integration test: Two MemoryManagers sharing via a "shared" InMemoryStore.
 *
 * This proves the core thesis: cross-agent sharing works via Meilisearch indexes.
 * We use InMemoryStore instances as mock Meilisearch stores for testing.
 */
describe("cross-agent sharing (integration)", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs) {
			try {
				rmSync(dir, { recursive: true });
			} catch {}
		}
		dirs.length = 0;
	});

	function makeTmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "cross-agent-integ-"));
		dirs.push(dir);
		return dir;
	}

	/**
	 * Create a MemoryManager for an agent with a shared store accessible via storeFactory.
	 */
	function makeAgent(
		name: string,
		agentDir: string,
		sharedStore: MemoryStore,
		otherIndexes: string[] = [],
		sharedIndexName = "shared-team",
	) {
		const readFrom = [sharedIndexName, ...otherIndexes];
		const readLine = readFrom.map((s) => `"${s}"`).join(", ");

		const config = parseConfig(`
name: ${name}
runner:
  workdir: ${agentDir}
memory:
  url: http://localhost:7700
  apiKey: test
  sharing:
    publishTo: "${sharedIndexName}"
    readFrom: [${readLine}]
  autoInject:
    maxResults: 10
`);

		// Create a mapping of index names to stores
		const storeMap = new Map<string, MemoryStore>();
		storeMap.set(sharedIndexName, sharedStore);

		const storeFactory: StoreFactory = (opts) => {
			const existing = storeMap.get(opts.index);
			if (existing) return existing;
			return new InMemoryStore();
		};

		const ownStore = new InMemoryStore();

		const mgr = new MemoryManager({
			config,
			store: ownStore,
			storeFactory,
		});

		return { mgr, ownStore, config, storeMap };
	}

	test("Agent A indexes a learning and finds it in own search", async () => {
		const dirA = makeTmpDir();
		const sharedStore = new InMemoryStore();
		const { mgr } = makeAgent("agent-a", dirA, sharedStore);
		await mgr.init();

		await mgr.index({
			type: "learning",
			content: "Agent A learned about Docker deployment",
			contentHash: "hash-a-docker",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const results = await mgr.search("Docker");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results.some((r) => r.content.includes("Docker deployment"))).toBe(true);
	});

	test("Agent A publishes learning to shared store", async () => {
		const dirA = makeTmpDir();
		const sharedStore = new InMemoryStore();
		const { mgr } = makeAgent("agent-a", dirA, sharedStore);
		await mgr.init();

		await mgr.index({
			type: "learning",
			content: "Agent A learned about Railway deployment",
			contentHash: "hash-a-railway",
			category: "lesson",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		// Shared store should have the published doc
		const sharedDocs = await sharedStore.search("Railway", 10);
		expect(sharedDocs.length).toBeGreaterThanOrEqual(1);
		expect(sharedDocs.some((d) => d.content.includes("Railway deployment"))).toBe(true);
	});

	test("Agent B finds Agent A's published learning via searchForContext", async () => {
		const dirA = makeTmpDir();
		const dirB = makeTmpDir();
		const sharedStore = new InMemoryStore();

		const agentA = makeAgent("agent-a", dirA, sharedStore);
		const agentB = makeAgent("agent-b", dirB, sharedStore);

		await agentA.mgr.init();
		await agentB.mgr.init();

		// Agent A publishes a learning
		await agentA.mgr.index({
			type: "learning",
			content: "The Supabase connection needs retry logic",
			contentHash: "hash-a-supabase",
			category: "lesson",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		// Agent B searches and should find Agent A's learning
		const context = await agentB.mgr.searchForContext("Supabase");
		expect(context.length).toBeGreaterThanOrEqual(1);
		expect(context.some((c) => c.includes("Supabase connection needs retry logic"))).toBe(true);
	});

	test("Bidirectional sharing: both agents publish and find each other's learnings", async () => {
		const dirA = makeTmpDir();
		const dirB = makeTmpDir();
		const sharedStore = new InMemoryStore();

		const agentA = makeAgent("agent-a", dirA, sharedStore);
		const agentB = makeAgent("agent-b", dirB, sharedStore);

		await agentA.mgr.init();
		await agentB.mgr.init();

		// Agent A publishes
		await agentA.mgr.index({
			type: "learning",
			content: "Use bun test for all testing",
			contentHash: "hash-a-bun",
			category: "pattern",
			source: "self",
			timestamp: "2025-01-01T00:00:00Z",
		});

		// Agent B publishes
		await agentB.mgr.index({
			type: "learning",
			content: "Always run bun lint before committing",
			contentHash: "hash-b-bun",
			category: "pattern",
			source: "self",
			timestamp: "2025-06-01T00:00:00Z",
		});

		// Agent A finds B's learning
		const contextA = await agentA.mgr.searchForContext("bun");
		expect(contextA.length).toBeGreaterThanOrEqual(2);
		expect(contextA.some((c) => c.includes("bun lint before committing"))).toBe(true);

		// Agent B finds A's learning
		const contextB = await agentB.mgr.searchForContext("bun");
		expect(contextB.length).toBeGreaterThanOrEqual(2);
		expect(contextB.some((c) => c.includes("bun test for all testing"))).toBe(true);
	});

	test("Private learnings without publishTo stay private", async () => {
		const dirA = makeTmpDir();
		const dirB = makeTmpDir();
		const sharedStore = new InMemoryStore();

		// Agent A has publishTo configured
		const agentA = makeAgent("agent-a", dirA, sharedStore);

		// Agent B does NOT have publishTo configured
		const configB = parseConfig(`
name: agent-b
runner:
  workdir: ${dirB}
memory:
  url: http://localhost:7700
  apiKey: test
  sharing:
    readFrom: ["shared-team"]
  autoInject:
    maxResults: 10
`);

		const ownStoreB = new InMemoryStore();
		const agentB = new MemoryManager({
			config: configB,
			store: ownStoreB,
			storeFactory: (opts) => {
				if (opts.index === "shared-team") return sharedStore;
				return new InMemoryStore();
			},
		});

		await agentA.mgr.init();
		await agentB.init();

		// Agent B indexes a private learning (no publishTo)
		await agentB.index({
			type: "learning",
			content: "Private secret of Agent B",
			contentHash: "hash-b-secret",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		// Agent A should NOT find B's private learning in shared store
		const sharedDocs = await sharedStore.search("Private secret", 10);
		expect(sharedDocs).toHaveLength(0);

		// Agent A search should also not find it
		const contextA = await agentA.mgr.searchForContext("Private secret");
		expect(contextA).toHaveLength(0);
	});
});

/**
 * Simple in-memory store for use as mock Meilisearch in tests.
 */
class InMemoryStore implements MemoryStore {
	private docs: MemoryDoc[] = [];

	async init(): Promise<void> {}

	async search(query: string, limit: number): Promise<MemoryDoc[]> {
		const lower = query.toLowerCase();
		return this.docs.filter((d) => d.content.toLowerCase().includes(lower)).slice(0, limit);
	}

	async index(doc: Omit<MemoryDoc, "id">): Promise<{ status: "success" }> {
		this.docs.push({
			...doc,
			id: `inmem-${Date.now()}-${Math.random()}`,
		});
		return { status: "success" };
	}

	async recent(limit: number): Promise<MemoryDoc[]> {
		return this.docs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
	}
}
