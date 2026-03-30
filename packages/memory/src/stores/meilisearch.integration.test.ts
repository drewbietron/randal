import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MeilisearchStore } from "./meilisearch.js";

// ---------------------------------------------------------------------------
// Configuration — uses env vars with sensible defaults for local dev
// ---------------------------------------------------------------------------

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7701";
const MEILI_KEY = process.env.MEILI_MASTER_KEY || "randal-local-key";
const TEST_INDEX = `test-memory-${Date.now()}`;

// ---------------------------------------------------------------------------
// Meilisearch availability check — skip all tests if not reachable
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MeilisearchStore integration", () => {
	itMeili("creates the index on init()", async () => {
		const store = new MeilisearchStore({
			url: MEILI_URL,
			apiKey: MEILI_KEY,
			index: TEST_INDEX,
		});

		await store.init();
		await waitForIndexing(TEST_INDEX);

		// Verify the index exists via the REST API
		const resp = await fetch(`${MEILI_URL}/indexes/${TEST_INDEX}`, {
			headers: { Authorization: `Bearer ${MEILI_KEY}` },
		});
		expect(resp.status).toBe(200);

		const body = (await resp.json()) as { uid: string };
		expect(body.uid).toBe(TEST_INDEX);
	});

	itMeili("store and retrieve round-trip via search()", async () => {
		const store = new MeilisearchStore({
			url: MEILI_URL,
			apiKey: MEILI_KEY,
			index: TEST_INDEX,
		});
		await store.init();

		await store.index({
			type: "learning",
			file: "",
			content: "TypeScript strict mode catches null reference errors at compile time",
			contentHash: `hash-integration-${Date.now()}-search`,
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
			scope: "global",
		});

		await waitForIndexing(TEST_INDEX);

		const results = await store.search("TypeScript strict mode", 10);
		expect(results.length).toBeGreaterThanOrEqual(1);

		const found = results.find((doc) => doc.content.includes("TypeScript strict mode"));
		expect(found).toBeDefined();
		if (!found) throw new Error("Expected document not found in search results");
		expect(found.category).toBe("fact");
	});

	itMeili("recent() returns documents sorted by timestamp descending", async () => {
		const store = new MeilisearchStore({
			url: MEILI_URL,
			apiKey: MEILI_KEY,
			index: TEST_INDEX,
		});
		await store.init();

		const now = Date.now();
		const docs = [
			{
				type: "learning" as const,
				file: "",
				content: "Recent test doc A (oldest)",
				contentHash: `hash-recent-a-${now}`,
				category: "pattern" as const,
				source: "self" as const,
				timestamp: new Date(now - 2000).toISOString(),
				scope: "global",
			},
			{
				type: "learning" as const,
				file: "",
				content: "Recent test doc B (middle)",
				contentHash: `hash-recent-b-${now}`,
				category: "pattern" as const,
				source: "self" as const,
				timestamp: new Date(now - 1000).toISOString(),
				scope: "global",
			},
			{
				type: "learning" as const,
				file: "",
				content: "Recent test doc C (newest)",
				contentHash: `hash-recent-c-${now}`,
				category: "pattern" as const,
				source: "self" as const,
				timestamp: new Date(now).toISOString(),
				scope: "global",
			},
		];

		for (const doc of docs) {
			await store.index(doc);
		}
		await waitForIndexing(TEST_INDEX);

		const results = await store.recent(2);
		expect(results.length).toBeGreaterThanOrEqual(2);

		// Most recent should come first
		const firstTimestamp = new Date(results[0].timestamp).getTime();
		const secondTimestamp = new Date(results[1].timestamp).getTime();
		expect(firstTimestamp).toBeGreaterThanOrEqual(secondTimestamp);
	});

	itMeili("deduplicates documents by contentHash", async () => {
		const store = new MeilisearchStore({
			url: MEILI_URL,
			apiKey: MEILI_KEY,
			index: TEST_INDEX,
		});
		await store.init();

		const uniqueHash = `hash-dedup-${Date.now()}`;

		await store.index({
			type: "learning",
			file: "",
			content: "Deduplicated content — first insert",
			contentHash: uniqueHash,
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
			scope: "global",
		});

		await waitForIndexing(TEST_INDEX);

		// Insert again with the same contentHash
		await store.index({
			type: "learning",
			file: "",
			content: "Deduplicated content — second insert (should be skipped)",
			contentHash: uniqueHash,
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
			scope: "global",
		});

		await waitForIndexing(TEST_INDEX);

		// Search for docs with this hash — should find exactly one
		const resp = await fetch(`${MEILI_URL}/indexes/${TEST_INDEX}/search`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${MEILI_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				q: "",
				filter: `contentHash = "${uniqueHash}"`,
				limit: 10,
			}),
		});
		expect(resp.ok).toBe(true);

		const body = (await resp.json()) as { hits: unknown[] };
		expect(body.hits.length).toBe(1);
	});

	itMeili("auth failure produces a specific error", async () => {
		const store = new MeilisearchStore({
			url: MEILI_URL,
			apiKey: "wrong-api-key-that-should-fail",
			index: `test-auth-fail-${Date.now()}`,
		});

		try {
			await store.init();
			// If init() doesn't throw, the test should fail
			expect(true).toBe(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const lower = message.toLowerCase();
			// Meilisearch returns 401/403 for invalid API keys with messages about
			// "invalid api key", "unauthorized", or status codes
			expect(
				lower.includes("401") ||
					lower.includes("403") ||
					lower.includes("unauthorized") ||
					lower.includes("invalid api key") ||
					lower.includes("invalid_api_key"),
			).toBe(true);
		}
	});

	itMeili("connection failure produces a specific error", async () => {
		const store = new MeilisearchStore({
			url: "http://localhost:19999",
			apiKey: MEILI_KEY,
			index: `test-conn-fail-${Date.now()}`,
		});

		try {
			await store.init();
			// If init() doesn't throw, the test should fail
			expect(true).toBe(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const lower = message.toLowerCase();
			// Should indicate a connection failure — Meilisearch SDK may wrap the error
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
