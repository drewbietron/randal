import type { MemoryDoc, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeilisearchStore } from "./stores/meilisearch.js";

const logger = createLogger({ context: { component: "cross-agent" } });

export interface CrossAgentOptions {
	config: RandalConfig;
}

/**
 * Search across multiple agent memory indexes.
 */
export async function searchCrossAgent(
	query: string,
	config: RandalConfig,
	limit = 5,
): Promise<MemoryDoc[]> {
	const readFrom = config.memory.sharing.readFrom;
	if (readFrom.length === 0) return [];

	const results: MemoryDoc[] = [];

	for (const indexName of readFrom) {
		try {
			const store = new MeilisearchStore({
				url: config.memory.url,
				apiKey: config.memory.apiKey,
				index: indexName,
			});

			const docs = await store.search(query, limit);
			results.push(...docs);
		} catch (err) {
			logger.warn("Cross-agent search failed for index", {
				index: indexName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Sort by timestamp descending and limit
	return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

/**
 * Publish a learning to the shared index.
 */
export async function publishToShared(
	doc: Omit<MemoryDoc, "id">,
	config: RandalConfig,
): Promise<void> {
	if (!config.memory.sharing.publishTo) return;

	try {
		const store = new MeilisearchStore({
			url: config.memory.url,
			apiKey: config.memory.apiKey,
			index: config.memory.sharing.publishTo,
		});

		await store.index(doc);
	} catch (err) {
		logger.error("Failed to publish to shared index", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Search skills across shared skill indexes.
 */
export async function searchSharedSkills(
	query: string,
	config: RandalConfig,
	limit = 5,
): Promise<MemoryDoc[]> {
	const readFrom = config.skills.sharing.readFrom;
	if (readFrom.length === 0) return [];

	const results: MemoryDoc[] = [];

	for (const indexName of readFrom) {
		try {
			const store = new MeilisearchStore({
				url: config.memory.url,
				apiKey: config.memory.apiKey,
				index: indexName,
			});

			const docs = await store.search(query, limit);
			results.push(...docs);
		} catch (err) {
			logger.warn("Shared skill search failed for index", {
				index: indexName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

/**
 * Publish a skill to the shared skills index.
 */
export async function publishSkillToShared(
	doc: Omit<MemoryDoc, "id">,
	config: RandalConfig,
): Promise<void> {
	if (!config.skills.sharing.publishTo) return;

	try {
		const store = new MeilisearchStore({
			url: config.memory.url,
			apiKey: config.memory.apiKey,
			index: config.skills.sharing.publishTo,
		});

		await store.index(doc);
	} catch (err) {
		logger.error("Failed to publish skill to shared index", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
