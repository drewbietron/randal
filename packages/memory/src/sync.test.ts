import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryDoc } from "@randal/core";
import { parseConfig } from "@randal/core";
import type { StoreFactory } from "./cross-agent.js";
import { MemoryManager } from "./memory.js";
import type { MemoryStore } from "./stores/index.js";
import { hashContent } from "./sync.js";

/**
 * In-memory mock store for testing.
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

describe("sync sharing-aware indexing (R1.3)", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs) {
			try {
				rmSync(dir, { recursive: true });
			} catch {}
		}
		dirs.length = 0;
	});

	test("index through MemoryManager publishes to shared when configured", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sync-share-test-"));
		dirs.push(dir);

		const sharedStore = new MockStore();
		const crossStores = new Map<string, MemoryStore>();
		crossStores.set("shared-team", sharedStore);

		const storeFactory: StoreFactory = (opts) => {
			return crossStores.get(opts.index) ?? new MockStore();
		};

		const config = parseConfig(`
name: test-agent
runner:
  workdir: ${dir}
memory:
  store: file
  files: [MEMORY.md]
  sharing:
    publishTo: shared-team
    readFrom: []
`);

		const ownStore = new MockStore();
		const mgr = new MemoryManager({
			config,
			store: ownStore,
			storeFactory,
		});

		// Simulate what sync.ts handleChange does — call memoryManager.index()
		await mgr.index({
			type: "snapshot",
			file: "MEMORY.md",
			content: "synced content",
			contentHash: hashContent("synced content"),
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		// Own store should have the doc
		expect(ownStore.getDocs()).toHaveLength(1);

		// Shared store should also have the doc (published via R1.2)
		expect(sharedStore.getDocs()).toHaveLength(1);
		expect(sharedStore.getDocs()[0].content).toBe("synced content");
	});

	test("index through MemoryManager does not publish when no publishTo", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sync-no-share-test-"));
		dirs.push(dir);

		const sharedStore = new MockStore();
		const crossStores = new Map<string, MemoryStore>();
		crossStores.set("shared-team", sharedStore);

		const storeFactory: StoreFactory = (opts) => {
			return crossStores.get(opts.index) ?? new MockStore();
		};

		const config = parseConfig(`
name: test-agent
runner:
  workdir: ${dir}
memory:
  store: file
  files: [MEMORY.md]
  sharing:
    readFrom: []
`);

		const ownStore = new MockStore();
		const mgr = new MemoryManager({
			config,
			store: ownStore,
			storeFactory,
		});

		await mgr.index({
			type: "learning",
			file: "MEMORY.md",
			content: "private content",
			contentHash: hashContent("private content"),
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		// Own store should have the doc
		expect(ownStore.getDocs()).toHaveLength(1);

		// Shared store should NOT have the doc
		expect(sharedStore.getDocs()).toHaveLength(0);
	});
});
