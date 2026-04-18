import { describe, expect, test } from "bun:test";
import type { MemoryDoc } from "@randal/core";
import { parseConfig } from "@randal/core";
import {
	type StoreFactory,
	publishSkillToShared,
	publishToShared,
	searchCrossAgent,
	searchSharedSkills,
} from "./cross-agent.js";
import type { IndexResult, MemoryStore } from "./stores/index.js";

/**
 * In-memory mock store for testing cross-agent functions without Meilisearch.
 */
class MockStore implements MemoryStore {
	private docs: MemoryDoc[] = [];

	async init(): Promise<void> {}

	async search(query: string, limit: number): Promise<MemoryDoc[]> {
		const lower = query.toLowerCase();
		return this.docs.filter((d) => d.content.toLowerCase().includes(lower)).slice(0, limit);
	}

	async index(doc: Omit<MemoryDoc, "id">): Promise<IndexResult> {
		this.docs.push({ ...doc, id: `mock-${Date.now()}-${Math.random()}` });
		return { status: "success" };
	}

	async recent(limit: number): Promise<MemoryDoc[]> {
		return this.docs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
	}

	getDocs(): MemoryDoc[] {
		return [...this.docs];
	}
}

/**
 * Mock store that always throws (simulates Meilisearch being down).
 */
class FailingStore implements MemoryStore {
	async init(): Promise<void> {
		throw new Error("Connection refused");
	}
	async search(): Promise<MemoryDoc[]> {
		throw new Error("Connection refused");
	}
	async index(): Promise<IndexResult> {
		throw new Error("Connection refused");
	}
	async recent(): Promise<MemoryDoc[]> {
		throw new Error("Connection refused");
	}
}

function makeConfig(
	overrides: {
		readFrom?: string[];
		publishTo?: string;
		skillsReadFrom?: string[];
		skillsPublishTo?: string;
	} = {},
) {
	const memPublish = overrides.publishTo ? `\n    publishTo: "${overrides.publishTo}"` : "";
	const skillsPublish = overrides.skillsPublishTo
		? `\n    publishTo: "${overrides.skillsPublishTo}"`
		: "";
	const memRead =
		(overrides.readFrom ?? []).length > 0
			? `\n    readFrom: [${(overrides.readFrom ?? []).map((s) => `"${s}"`).join(", ")}]`
			: "\n    readFrom: []";
	const skillsRead =
		(overrides.skillsReadFrom ?? []).length > 0
			? `\n    readFrom: [${(overrides.skillsReadFrom ?? []).map((s) => `"${s}"`).join(", ")}]`
			: "\n    readFrom: []";

	return parseConfig(`
name: test-agent
runner:
  workdir: /tmp
memory:
  url: http://localhost:7701
  apiKey: test-key
  sharing:${memPublish}${memRead}
skills:
  sharing:${skillsPublish}${skillsRead}
`);
}

function makeDoc(content: string, source = "self", timestamp?: string): Omit<MemoryDoc, "id"> {
	return {
		type: "learning",
		file: "MEMORY.md",
		content,
		contentHash: `hash-${content.replace(/\s+/g, "-")}`,
		category: "fact",
		source: source as MemoryDoc["source"],
		timestamp: timestamp ?? new Date().toISOString(),
	};
}

describe("searchCrossAgent", () => {
	test("returns empty when no readFrom configured", async () => {
		const config = makeConfig({ readFrom: [] });
		const results = await searchCrossAgent("test", config);
		expect(results).toEqual([]);
	});

	test("searches a single cross-agent index", async () => {
		const stores = new Map<string, MockStore>();
		const sharedStore = new MockStore();
		await sharedStore.index(makeDoc("shared learning about APIs", "agent:ops"));
		stores.set("shared-team", sharedStore);

		const factory: StoreFactory = (opts) => {
			return stores.get(opts.index) ?? new MockStore();
		};

		const config = makeConfig({ readFrom: ["shared-team"] });
		const results = await searchCrossAgent("APIs", config, 5, factory);
		expect(results).toHaveLength(1);
		expect(results[0].content).toBe("shared learning about APIs");
	});

	test("searches multiple cross-agent indexes", async () => {
		const stores = new Map<string, MockStore>();
		const store1 = new MockStore();
		await store1.index(makeDoc("agent alpha learning", "agent:alpha"));
		stores.set("memory-alpha", store1);

		const store2 = new MockStore();
		await store2.index(makeDoc("agent beta learning", "agent:beta"));
		stores.set("memory-beta", store2);

		const factory: StoreFactory = (opts) => {
			return stores.get(opts.index) ?? new MockStore();
		};

		const config = makeConfig({ readFrom: ["memory-alpha", "memory-beta"] });
		const results = await searchCrossAgent("learning", config, 10, factory);
		expect(results).toHaveLength(2);
	});

	test("sorts results by timestamp descending", async () => {
		const stores = new Map<string, MockStore>();
		const store = new MockStore();
		await store.index(makeDoc("old learning", "agent:ops", "2024-01-01T00:00:00Z"));
		await store.index(makeDoc("new learning", "agent:ops", "2025-01-01T00:00:00Z"));
		stores.set("shared", store);

		const factory: StoreFactory = (opts) => stores.get(opts.index) ?? new MockStore();

		const config = makeConfig({ readFrom: ["shared"] });
		const results = await searchCrossAgent("learning", config, 10, factory);
		expect(results).toHaveLength(2);
		expect(results[0].content).toBe("new learning");
		expect(results[1].content).toBe("old learning");
	});

	test("respects limit parameter", async () => {
		const stores = new Map<string, MockStore>();
		const store = new MockStore();
		for (let i = 0; i < 10; i++) {
			await store.index(makeDoc(`learning ${i}`, "agent:ops"));
		}
		stores.set("shared", store);

		const factory: StoreFactory = (opts) => stores.get(opts.index) ?? new MockStore();

		const config = makeConfig({ readFrom: ["shared"] });
		const results = await searchCrossAgent("learning", config, 3, factory);
		expect(results).toHaveLength(3);
	});

	test("continues when one index fails", async () => {
		const stores = new Map<string, MemoryStore>();
		stores.set("failing-index", new FailingStore());

		const goodStore = new MockStore();
		await goodStore.index(makeDoc("good learning", "agent:ops"));
		stores.set("good-index", goodStore);

		const factory: StoreFactory = (opts) => stores.get(opts.index) ?? new MockStore();

		const config = makeConfig({ readFrom: ["failing-index", "good-index"] });
		const results = await searchCrossAgent("learning", config, 10, factory);
		expect(results).toHaveLength(1);
		expect(results[0].content).toBe("good learning");
	});

	test("returns empty when all indexes fail", async () => {
		const factory: StoreFactory = () => new FailingStore();

		const config = makeConfig({ readFrom: ["index-1", "index-2"] });
		const results = await searchCrossAgent("test", config, 5, factory);
		expect(results).toEqual([]);
	});
});

describe("publishToShared", () => {
	test("no-op when publishTo is not configured", async () => {
		const store = new MockStore();
		const factory: StoreFactory = () => store;

		const config = makeConfig({ publishTo: "" });
		await publishToShared(makeDoc("test"), config, factory);
		expect(store.getDocs()).toHaveLength(0);
	});

	test("publishes doc to shared index", async () => {
		const stores = new Map<string, MockStore>();
		const sharedStore = new MockStore();
		stores.set("shared-team", sharedStore);

		const factory: StoreFactory = (opts) => stores.get(opts.index) ?? new MockStore();

		const config = makeConfig({ publishTo: "shared-team" });
		const doc = makeDoc("learning to share");
		await publishToShared(doc, config, factory);

		const docs = sharedStore.getDocs();
		expect(docs).toHaveLength(1);
		expect(docs[0].content).toBe("learning to share");
	});

	test("does not throw when publishing fails", async () => {
		const factory: StoreFactory = () => new FailingStore();

		const config = makeConfig({ publishTo: "shared-team" });
		// Should not throw
		await publishToShared(makeDoc("test"), config, factory);
	});
});

describe("searchSharedSkills", () => {
	test("returns empty when no skills readFrom configured", async () => {
		const config = makeConfig({ skillsReadFrom: [] });
		const results = await searchSharedSkills("test", config);
		expect(results).toEqual([]);
	});

	test("searches shared skill indexes", async () => {
		const stores = new Map<string, MockStore>();
		const store = new MockStore();
		await store.index(makeDoc("skill about deployment", "agent:ops"));
		stores.set("shared-skills", store);

		const factory: StoreFactory = (opts) => stores.get(opts.index) ?? new MockStore();

		const config = makeConfig({ skillsReadFrom: ["shared-skills"] });
		const results = await searchSharedSkills("deployment", config, 5, factory);
		expect(results).toHaveLength(1);
		expect(results[0].content).toBe("skill about deployment");
	});

	test("continues when skill index fails", async () => {
		const stores = new Map<string, MemoryStore>();
		stores.set("failing", new FailingStore());

		const goodStore = new MockStore();
		await goodStore.index(makeDoc("good skill", "agent:ops"));
		stores.set("good", goodStore);

		const factory: StoreFactory = (opts) => stores.get(opts.index) ?? new MockStore();

		const config = makeConfig({ skillsReadFrom: ["failing", "good"] });
		const results = await searchSharedSkills("skill", config, 10, factory);
		expect(results).toHaveLength(1);
	});
});

describe("publishSkillToShared", () => {
	test("no-op when skills publishTo is not configured", async () => {
		const store = new MockStore();
		const factory: StoreFactory = () => store;

		const config = makeConfig({ skillsPublishTo: "" });
		await publishSkillToShared(makeDoc("skill"), config, factory);
		expect(store.getDocs()).toHaveLength(0);
	});

	test("publishes skill to shared skills index", async () => {
		const stores = new Map<string, MockStore>();
		const sharedStore = new MockStore();
		stores.set("shared-skills-team", sharedStore);

		const factory: StoreFactory = (opts) => stores.get(opts.index) ?? new MockStore();

		const config = makeConfig({ skillsPublishTo: "shared-skills-team" });
		await publishSkillToShared(makeDoc("shared skill"), config, factory);

		const docs = sharedStore.getDocs();
		expect(docs).toHaveLength(1);
		expect(docs[0].content).toBe("shared skill");
	});

	test("does not throw when publishing fails", async () => {
		const factory: StoreFactory = () => new FailingStore();

		const config = makeConfig({ skillsPublishTo: "shared-skills" });
		// Should not throw
		await publishSkillToShared(makeDoc("test"), config, factory);
	});
});
