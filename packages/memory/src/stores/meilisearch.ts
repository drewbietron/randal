import { randomUUID } from "node:crypto";
import type { MemoryDoc } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeiliSearch } from "meilisearch";
import type { MemorySearchOptions, MemoryStore } from "./index.js";

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

/** Categories that default to global scope (cross-project). */
const GLOBAL_SCOPE_CATEGORIES = new Set(["preference", "fact"]);

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
				"scope",
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
						url: this.embedderConfig.url || "https://openrouter.ai/api/v1/embeddings",
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

	async search(query: string, limit: number, options?: MemorySearchOptions): Promise<MemoryDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const scopeFilter = this.buildScopeFilter(options?.scope);

			if (this.semanticAvailable) {
				// Hybrid search: Meilisearch uses its own relevance ranking,
				// sort is not compatible with hybrid search
				const results = await index.search(query, {
					limit,
					hybrid: {
						embedder: EMBEDDER_NAME,
						semanticRatio: this.semanticRatio,
					},
					...(scopeFilter ? { filter: scopeFilter } : {}),
				});
				return results.hits as unknown as MemoryDoc[];
			}

			// Keyword-only fallback
			const results = await index.search(query, {
				limit,
				sort: ["timestamp:desc"],
				...(scopeFilter ? { filter: scopeFilter } : {}),
			});
			return results.hits as unknown as MemoryDoc[];
		} catch (err) {
			this.logger.error("Meilisearch search failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/**
	 * Build a Meilisearch filter string for scope-based filtering.
	 *
	 * - If scope starts with "project:", return project + global memories.
	 * - If scope is "all" or undefined, no scope filter (backward-compatible).
	 */
	private buildScopeFilter(scope: string | undefined): string | undefined {
		if (!scope || scope === "all") {
			return undefined;
		}

		if (scope.startsWith("project:")) {
			// Escape double quotes in the scope value to prevent filter injection
			const escapedScope = scope.replace(/"/g, '\\"');
			return `(scope = "global" OR scope = "${escapedScope}")`;
		}

		return undefined;
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

			// Assign default scope if not explicitly set
			const scope = doc.scope ?? this.defaultScopeForCategory(doc.category);

			const fullDoc: MemoryDoc = {
				...doc,
				scope,
				id: randomUUID(),
			};
			await idx.addDocuments([fullDoc]);
		} catch (err) {
			this.logger.error("Meilisearch indexing failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Determine default scope for a memory category.
	 * `preference` and `fact` are global (cross-project).
	 * All other categories default to "global" unless a project scope is provided at call time.
	 */
	private defaultScopeForCategory(category: string): string {
		if (GLOBAL_SCOPE_CATEGORIES.has(category)) {
			return "global";
		}
		// Without project context at this layer, default to "global".
		// Callers (MemoryManager, MCP server) should set scope explicitly for project-scoped memories.
		return "global";
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
