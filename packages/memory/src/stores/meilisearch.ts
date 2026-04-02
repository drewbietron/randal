import { randomUUID } from "node:crypto";
import type { MemoryDoc } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeiliSearch } from "meilisearch";
import type { EmbeddingService } from "../embedding.js";
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
	/** @deprecated Use `embeddingService` instead. Kept for backward compatibility. */
	embedder?: EmbedderConfig;
	/** Application-managed embedding service. If provided, vectors are generated externally and attached to docs. */
	embeddingService?: EmbeddingService;
	semanticRatio?: number;
}

const EMBEDDER_NAME = "default";
const DEFAULT_SEMANTIC_RATIO = 0.7;

/** Categories that default to global scope (cross-project). */
const GLOBAL_SCOPE_CATEGORIES = new Set(["preference", "fact"]);

export class MeilisearchStore implements MemoryStore {
	private client: MeiliSearch;
	private indexName: string;
	private embeddingService?: EmbeddingService;
	private semanticRatio: number;
	private logger = createLogger({ context: { component: "meilisearch-store" } });

	constructor(options: MeilisearchStoreOptions) {
		this.client = new MeiliSearch({
			host: options.url,
			apiKey: options.apiKey,
		});
		this.indexName = options.index;
		this.embeddingService = options.embeddingService;
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

		// Register a userProvided embedder so Meilisearch accepts _vectors and supports hybrid search.
		// This is non-fatal — if it fails, we still store docs (keyword-only).
		if (this.embeddingService) {
			try {
				const index = this.client.index(this.indexName);
				await index.updateEmbedders({
					[EMBEDDER_NAME]: {
						source: "userProvided",
						dimensions: this.embeddingService.dimensions,
					},
				});
				this.logger.info("userProvided embedder registered for manual vectors", {
					embedder: EMBEDDER_NAME,
					dimensions: this.embeddingService.dimensions,
				});
			} catch (err) {
				this.logger.warn("Failed to register userProvided embedder — hybrid search may not work", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	async search(query: string, limit: number, options?: MemorySearchOptions): Promise<MemoryDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const scopeFilter = this.buildScopeFilter(options?.scope);

			// Try hybrid search: embed the query, then use vector + keyword
			if (this.embeddingService) {
				const queryVector = await this.embeddingService.embed(query);

				if (queryVector) {
					// Hybrid search with application-provided query vector
					const results = await index.search(query, {
						limit,
						vector: queryVector,
						hybrid: {
							embedder: EMBEDDER_NAME,
							semanticRatio: this.semanticRatio,
						},
						...(scopeFilter ? { filter: scopeFilter } : {}),
					});
					return results.hits as unknown as MemoryDoc[];
				}

				// Query embedding failed — fall through to keyword-only
				this.logger.warn("Query embedding failed, falling back to keyword-only search");
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

			// Try to generate an embedding for the document content
			let vectors: Record<string, { value: number[] }> | undefined;
			if (this.embeddingService) {
				const embedding = await this.embeddingService.embed(doc.content);
				if (embedding) {
					vectors = { [EMBEDDER_NAME]: { value: embedding } };
				}
			}

			const fullDoc = {
				...doc,
				scope,
				id: randomUUID(),
				...(vectors ? { _vectors: vectors } : {}),
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
