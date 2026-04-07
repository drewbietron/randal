import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConfig } from "@randal/core";
import { MessageManager } from "./messages.js";
import type { MessageManagerOptions } from "./messages.js";

// ---------------------------------------------------------------------------
// Configuration — uses env vars with sensible defaults for local dev
// ---------------------------------------------------------------------------

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7701";
const MEILI_KEY = process.env.MEILI_MASTER_KEY || "randal-local-key";
const TEST_INDEX = `test-messages-${Date.now()}`;

// ---------------------------------------------------------------------------
// Meilisearch availability check — skip all tests if not reachable or auth fails
// ---------------------------------------------------------------------------

let meiliAvailable = false;

beforeAll(async () => {
	try {
		// Check health first (unauthenticated)
		const healthResp = await fetch(`${MEILI_URL}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!healthResp.ok) {
			meiliAvailable = false;
			console.log(
				`\u26a0\ufe0f  Meilisearch not healthy at ${MEILI_URL} — skipping integration tests`,
			);
			return;
		}
		// Verify the API key actually works (authenticated endpoint)
		const authResp = await fetch(`${MEILI_URL}/indexes`, {
			headers: { Authorization: `Bearer ${MEILI_KEY}` },
			signal: AbortSignal.timeout(3000),
		});
		if (!authResp.ok) {
			meiliAvailable = false;
			console.log(
				`\u26a0\ufe0f  Meilisearch is running but API key is invalid (HTTP ${authResp.status}) — skipping integration tests`,
			);
			return;
		}
		meiliAvailable = true;
	} catch {
		meiliAvailable = false;
		console.log(
			`\u26a0\ufe0f  Meilisearch not reachable at ${MEILI_URL} — skipping integration tests`,
		);
	}
});

afterAll(async () => {
	if (!meiliAvailable) return;
	// Clean up: delete the test index
	try {
		await fetch(`${MEILI_URL}/indexes/${TEST_INDEX}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${MEILI_KEY}` },
		});
	} catch {
		// Best effort — test index may not exist
	}
});

/**
 * Conditional test helper — skips the test body if Meilisearch is not available.
 * The test still appears in output (as a pass) but performs no assertions.
 */
function itMeili(name: string, fn: () => Promise<void>): void {
	test(name, async () => {
		if (!meiliAvailable) return;
		await fn();
	});
}

/**
 * Wait for Meilisearch to finish async indexing tasks for the given index.
 * Polls the tasks endpoint until all enqueued/processing tasks are complete.
 */
async function waitForIndexing(indexUid: string, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const resp = await fetch(
			`${MEILI_URL}/tasks?indexUids=${indexUid}&statuses=enqueued,processing`,
			{ headers: { Authorization: `Bearer ${MEILI_KEY}` } },
		);
		if (resp.ok) {
			const body = (await resp.json()) as { results: unknown[] };
			if (body.results.length === 0) return;
		}
		await Bun.sleep(200);
	}
	throw new Error(`Timed out waiting for indexing tasks on ${indexUid}`);
}

/**
 * Create a MessageManager with the test index name.
 * Uses a minimal config that satisfies the constructor requirements.
 */
function createTestManager(overrides: Partial<MessageManagerOptions> = {}): MessageManager {
	const config = parseConfig(`
name: test
runner:
  workdir: /tmp
`);
	// Override memory.url and memory.apiKey on the parsed config
	// biome-ignore lint/suspicious/noExplicitAny: test-only override of config fields
	const testConfig = { ...config, memory: { url: MEILI_URL, apiKey: MEILI_KEY } } as any;

	return new MessageManager({
		config: testConfig,
		indexName: TEST_INDEX,
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageManager integration", () => {
	itMeili("creates the index on init()", async () => {
		const manager = createTestManager();
		await manager.init();
		await waitForIndexing(TEST_INDEX);

		// Verify the index exists via the REST API
		const resp = await fetch(`${MEILI_URL}/indexes/${TEST_INDEX}`, {
			headers: { Authorization: `Bearer ${MEILI_KEY}` },
		});
		expect(resp.status).toBe(200);

		const body = (await resp.json()) as { uid: string; primaryKey: string };
		expect(body.uid).toBe(TEST_INDEX);
		expect(body.primaryKey).toBe("id");
	});

	itMeili("log and search round-trip", async () => {
		const manager = createTestManager();
		await manager.init();

		const threadId = `thread-integ-${Date.now()}`;
		const id = await manager.add({
			content: "discussing authentication flow for the new SSO integration",
			speaker: "user",
			threadId,
			channel: "opencode",
			timestamp: new Date().toISOString(),
			type: "message",
			scope: "global",
		});

		expect(id).toBeDefined();
		expect(typeof id).toBe("string");

		await waitForIndexing(TEST_INDEX);

		const results = await manager.search("authentication SSO", 10);
		expect(results.length).toBeGreaterThanOrEqual(1);

		const found = results.find((doc) => doc.content.includes("authentication flow"));
		expect(found).toBeDefined();
		if (!found) throw new Error("Expected message not found in search results");
		expect(found.speaker).toBe("user");
		expect(found.threadId).toBe(threadId);
	});

	itMeili("thread retrieval returns messages in chronological order", async () => {
		const manager = createTestManager();
		await manager.init();

		const threadId = `thread-order-${Date.now()}`;
		const now = Date.now();

		await manager.add({
			content: "Thread message 1 (first)",
			speaker: "user",
			threadId,
			channel: "opencode",
			timestamp: new Date(now - 2000).toISOString(),
			type: "message",
			scope: "global",
		});
		await manager.add({
			content: "Thread message 2 (second)",
			speaker: "randal",
			threadId,
			channel: "opencode",
			timestamp: new Date(now - 1000).toISOString(),
			type: "message",
			scope: "global",
		});
		await manager.add({
			content: "Thread message 3 (third)",
			speaker: "user",
			threadId,
			channel: "opencode",
			timestamp: new Date(now).toISOString(),
			type: "message",
			scope: "global",
		});

		await waitForIndexing(TEST_INDEX);

		const messages = await manager.thread(threadId, 10);
		expect(messages.length).toBe(3);

		// Should be chronological (ascending)
		const t1 = new Date(messages[0].timestamp).getTime();
		const t2 = new Date(messages[1].timestamp).getTime();
		const t3 = new Date(messages[2].timestamp).getTime();
		expect(t1).toBeLessThanOrEqual(t2);
		expect(t2).toBeLessThanOrEqual(t3);
	});

	itMeili("recent() returns most recent messages", async () => {
		const manager = createTestManager();
		await manager.init();

		const now = Date.now();
		const threadId = `thread-recent-${now}`;

		for (let i = 0; i < 5; i++) {
			await manager.add({
				content: `Recent test message ${i}`,
				speaker: "user",
				threadId,
				channel: "opencode",
				timestamp: new Date(now + i * 1000).toISOString(),
				type: "message",
				scope: "global",
			});
		}

		await waitForIndexing(TEST_INDEX);

		const results = await manager.recent(3);
		expect(results.length).toBeGreaterThanOrEqual(3);

		// Most recent should come first (descending)
		const t1 = new Date(results[0].timestamp).getTime();
		const t2 = new Date(results[1].timestamp).getTime();
		expect(t1).toBeGreaterThanOrEqual(t2);
	});

	itMeili("scope filtering returns only matching scope", async () => {
		const manager = createTestManager();
		await manager.init();

		const threadId = `thread-scope-${Date.now()}`;

		await manager.add({
			content: "global scope message about deployment pipelines",
			speaker: "user",
			threadId,
			channel: "opencode",
			timestamp: new Date().toISOString(),
			type: "message",
			scope: "global",
		});

		await manager.add({
			content: "project scope message about deployment pipelines in project-x",
			speaker: "user",
			threadId,
			channel: "opencode",
			timestamp: new Date().toISOString(),
			type: "message",
			scope: "project:/test/project-x",
		});

		await waitForIndexing(TEST_INDEX);

		const globalResults = await manager.search("deployment pipelines", 10, {
			scope: "global",
		});
		const projectResults = await manager.search("deployment pipelines", 10, {
			scope: "project:/test/project-x",
		});

		// Global search should only return the global-scoped message
		for (const doc of globalResults) {
			expect(doc.scope).toBe("global");
		}

		// Project search should only return the project-scoped message
		for (const doc of projectResults) {
			expect(doc.scope).toBe("project:/test/project-x");
		}
	});

	itMeili("auth failure produces a specific error on init()", async () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
`);
		// biome-ignore lint/suspicious/noExplicitAny: test-only config override
		const badConfig = { ...config, memory: { url: MEILI_URL, apiKey: "wrong-key" } } as any;

		const manager = new MessageManager({
			config: badConfig,
			indexName: `test-auth-fail-msg-${Date.now()}`,
		});

		try {
			await manager.init();
			expect(true).toBe(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const lower = message.toLowerCase();
			expect(
				lower.includes("401") ||
					lower.includes("403") ||
					lower.includes("unauthorized") ||
					lower.includes("invalid api key") ||
					lower.includes("invalid_api_key") ||
					lower.includes("api key is invalid"),
			).toBe(true);
		}
	});

	itMeili("connection failure produces a specific error on init()", async () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
`);
		const badConfig = {
			...config,
			memory: { url: "http://localhost:19999", apiKey: MEILI_KEY },
			// biome-ignore lint/suspicious/noExplicitAny: test-only config override
		} as any;

		const manager = new MessageManager({
			config: badConfig,
			indexName: `test-conn-fail-msg-${Date.now()}`,
		});

		try {
			await manager.init();
			expect(true).toBe(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const lower = message.toLowerCase();
			expect(
				lower.includes("econnrefused") ||
					lower.includes("fetch failed") ||
					lower.includes("failed") ||
					lower.includes("connect") ||
					lower.includes("unable to connect"),
			).toBe(true);
		}
	});
});
