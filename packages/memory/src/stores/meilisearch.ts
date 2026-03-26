import { randomUUID } from "node:crypto";
import type { MemoryDoc } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeiliSearch } from "meilisearch";
import type { MemoryStore } from "./index.js";

export interface EmbedderConfig {
	type: string;
	model: string;
	apiKey: string;
	url?: string;
}

export interface MeilisearchStoreOptions {
	url: string;
	apiKey: string;
	index: string;
	embedder?: EmbedderConfig;
	semanticRatio?: number;
}

const EMBEDDER_NAME = "memory-embedder";
const DEFAULT_SEMANTIC_RATIO = 0.7;

export class MeilisearchStore implements MemoryStore {
	private client: MeiliSearch;
	private indexName: string;
	private semanticAvailable = false;
	private semanticRatio: number;
	private embedderConfig?: EmbedderConfig;
	private logger = createLogger({ context: { component: "meilisearch-store" } });

	constructor(options: MeilisearchStoreOptions) {
		this.client = new MeiliSearch({
			host: options.url,
			apiKey: options.apiKey,
		});
		this.indexName = options.index;
		this.embedderConfig = options.embedder;
		this.semanticRatio = options.semanticRatio ?? DEFAULT_SEMANTIC_RATIO;
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

		// Configure semantic embedder (non-fatal — falls back to keyword search)
		if (this.embedderConfig?.apiKey) {
			try {
				const index = this.client.index(this.indexName);
				await index.updateEmbedders({
					[EMBEDDER_NAME]: {
						source: "rest",
						url:
							this.embedderConfig.url ||
							"https://openrouter.ai/api/v1/embeddings",
						apiKey: this.embedderConfig.apiKey,
						request: {
							model: this.embedderConfig.model,
							input: ["{{text}}", "{{..}}"],
						},
						response: {
							data: [{ embedding: "{{embedding}}" }, "{{..}}"],
						},
						documentTemplate: "A memory entry: {{doc.content}}",
					},
				});
				this.semanticAvailable = true;
				this.logger.info("Semantic search enabled", {
					embedder: EMBEDDER_NAME,
					model: this.embedderConfig.model,
					semanticRatio: this.semanticRatio,
				});
			} catch (err) {
				this.semanticAvailable = false;
				this.logger.warn(
					"Failed to configure semantic embedder — falling back to keyword-only search",
					{
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}
	}

	async search(query: string, limit: number): Promise<MemoryDoc[]> {
		try {
			const index = this.client.index(this.indexName);

			if (this.semanticAvailable) {
				// Hybrid search: Meilisearch uses its own relevance ranking,
				// sort is not compatible with hybrid search
				const results = await index.search(query, {
					limit,
					hybrid: {
						embedder: EMBEDDER_NAME,
						semanticRatio: this.semanticRatio,
					},
				});
				return results.hits as unknown as MemoryDoc[];
			}

			// Keyword-only fallback
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
