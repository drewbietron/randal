import { randomUUID } from "node:crypto";
import type { MemoryDoc } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeiliSearch } from "meilisearch";
import type { MemoryStore } from "./index.js";

export interface MeilisearchStoreOptions {
	url: string;
	apiKey: string;
	index: string;
}

export class MeilisearchStore implements MemoryStore {
	private client: MeiliSearch;
	private indexName: string;
	private logger = createLogger({ context: { component: "meilisearch-store" } });

	constructor(options: MeilisearchStoreOptions) {
		this.client = new MeiliSearch({
			host: options.url,
			apiKey: options.apiKey,
		});
		this.indexName = options.index;
	}

	async init(): Promise<void> {
		try {
			const index = this.client.index(this.indexName);

			// Configure searchable and filterable attributes
			await index.updateSearchableAttributes(["content", "category", "type", "source"]);
			await index.updateFilterableAttributes([
				"type",
				"category",
				"source",
				"file",
				"timestamp",
				"contentHash",
			]);
			await index.updateSortableAttributes(["timestamp"]);

			this.logger.info("Meilisearch index initialized", {
				index: this.indexName,
			});
		} catch (err) {
			this.logger.error("Failed to initialize Meilisearch index", {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	}

	async search(query: string, limit: number): Promise<MemoryDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const results = await index.search(query, {
				limit,
				sort: ["timestamp:desc"],
			});
			return results.hits as unknown as MemoryDoc[];
		} catch (err) {
			this.logger.error("Meilisearch search failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	async index(doc: Omit<MemoryDoc, "id">): Promise<void> {
		try {
			const idx = this.client.index(this.indexName);

			// Deduplicate: skip if a doc with the same contentHash already exists
			if (doc.contentHash) {
				const existing = await idx.search("", {
					filter: `contentHash = "${doc.contentHash}"`,
					limit: 1,
				});
				if (existing.hits.length > 0) {
					this.logger.info("Skipping duplicate memory", {
						contentHash: doc.contentHash,
					});
					return;
				}
			}

			const fullDoc: MemoryDoc = {
				...doc,
				id: randomUUID(),
			};
			await idx.addDocuments([fullDoc]);
		} catch (err) {
			this.logger.error("Meilisearch indexing failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async recent(limit: number): Promise<MemoryDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const results = await index.search("", {
				limit,
				sort: ["timestamp:desc"],
			});
			return results.hits as unknown as MemoryDoc[];
		} catch (err) {
			this.logger.error("Meilisearch recent query failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}
}
