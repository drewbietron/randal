import { randomUUID } from "node:crypto";
import type { MemoryDoc } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeiliSearch } from "meilisearch";
import type { EmbeddingService } from "../embedding.js";
import type { IndexResult, MemorySearchOptions, MemoryStore } from "./index.js";

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
	private meiliUrl: string;
	private semanticRatio: number;
	private logger = createLogger({ context: { component: "meilisearch-store" } });

	// Write-ahead queue for failed writes
	private writeQueue: Array<{ doc: Record<string, unknown>; queuedAt: number }> = [];
	private static readonly MAX_QUEUE_SIZE = 100;

	// Health monitoring
	private healthy = false;
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

	/** Number of documents waiting in the write-ahead queue. */
	get pendingWrites(): number {
		return this.writeQueue.length;
	}

	/** Whether the Meilisearch backend is currently reachable. */
	isHealthy(): boolean {
		return this.healthy;
	}

	constructor(options: MeilisearchStoreOptions) {
		this.client = new MeiliSearch({
			host: options.url,
			apiKey: options.apiKey,
		});
		this.meiliUrl = options.url;
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

		this.startHealthCheck();
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

	private static readonly INDEX_MAX_RETRIES = 3;

	async index(doc: Omit<MemoryDoc, "id">): Promise<IndexResult> {
		const idx = this.client.index(this.indexName);

		// Deduplicate: skip if a doc with the same contentHash already exists
		if (doc.contentHash) {
			try {
				const existing = await idx.search("", {
					filter: `contentHash = "${doc.contentHash}"`,
					limit: 1,
				});
				if (existing.hits.length > 0) {
					this.logger.info("Skipping duplicate memory", {
						contentHash: doc.contentHash,
					});
					return { status: "duplicate", contentHash: doc.contentHash };
				}
			} catch (err) {
				// Dedup check failed — continue with indexing attempt
				this.logger.warn("Dedup check failed, proceeding with index", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Assign default scope if not explicitly set
		const scope = doc.scope ?? this.defaultScopeForCategory(doc.category);

		// Try to generate an embedding for the document content
		let vectors: Record<string, number[]> | undefined;
		if (this.embeddingService) {
			const embedding = await this.embeddingService.embed(doc.content);
			if (embedding) {
				vectors = { [EMBEDDER_NAME]: embedding };
			}
		}

		const fullDoc: MemoryDoc = {
			...doc,
			scope,
			id: randomUUID(),
			...(vectors ? { _vectors: vectors } : {}),
		};

		// Retry the addDocuments call with exponential backoff
		let lastError = "";
		for (let attempt = 1; attempt <= MeilisearchStore.INDEX_MAX_RETRIES; attempt++) {
			try {
				await idx.addDocuments([fullDoc]);
				// Fire-and-forget: drain queued writes on success
				this.drainQueue().catch((err) => {
					this.logger.warn("drainQueue error (non-blocking)", {
						error: err instanceof Error ? err.message : String(err),
					});
				});
				return { status: "success" };
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				this.logger.warn(
					`index() attempt ${attempt}/${MeilisearchStore.INDEX_MAX_RETRIES} failed`,
					{
						error: lastError,
						docCategory: doc.category,
					},
				);
				if (attempt < MeilisearchStore.INDEX_MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 8000)));
				}
			}
		}

		// All retries exhausted — queue for later retry if space available
		if (this.writeQueue.length < MeilisearchStore.MAX_QUEUE_SIZE) {
			this.writeQueue.push({
				doc: fullDoc as unknown as Record<string, unknown>,
				queuedAt: Date.now(),
			});
			this.logger.warn("index() queued for later retry", {
				queueDepth: this.writeQueue.length,
				error: lastError,
			});
			return { status: "queued", reason: lastError };
		}

		this.logger.error("index() failed and write queue is full", {
			error: lastError,
			queueDepth: this.writeQueue.length,
		});
		return {
			status: "failed",
			error: `Write queue full (${MeilisearchStore.MAX_QUEUE_SIZE}): ${lastError}`,
		};
	}

	/**
	 * Drain up to 10 queued writes opportunistically.
	 * Called after a successful addDocuments() to flush pending items.
	 */
	private async drainQueue(): Promise<void> {
		if (this.writeQueue.length === 0) return;

		const idx = this.client.index(this.indexName);
		const batch = this.writeQueue.splice(0, 10);
		const failed: typeof batch = [];

		for (const item of batch) {
			try {
				await idx.addDocuments([item.doc]);
			} catch {
				failed.push(item);
			}
		}

		// Re-queue failures at the front
		if (failed.length > 0) {
			this.writeQueue.unshift(...failed);
			this.logger.warn(`drainQueue: ${failed.length}/${batch.length} items still failing`);
		} else if (batch.length > 0) {
			this.logger.info(`drainQueue: flushed ${batch.length} queued writes`);
		}
	}

	/**
	 * Start periodic health check — called at end of init().
	 * Pings Meilisearch `/health` every 30 seconds to detect outages and recovery.
	 */
	private startHealthCheck(): void {
		this.healthy = true; // if init() succeeded, we're healthy
		this.healthCheckInterval = setInterval(() => this.checkHealth(), 30_000);
	}

	private async checkHealth(): Promise<void> {
		try {
			const resp = await fetch(`${this.meiliUrl}/health`, {
				signal: AbortSignal.timeout(5000),
			});
			const wasHealthy = this.healthy;
			this.healthy = resp.ok;

			if (!wasHealthy && this.healthy) {
				this.logger.info("Meilisearch recovered — re-initializing indexes");
				await this.reInit();
			}
			if (wasHealthy && !this.healthy) {
				this.logger.warn("Meilisearch health check failed", { status: resp.status });
			}
		} catch (err) {
			if (this.healthy) {
				this.logger.warn("Meilisearch unreachable", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			this.healthy = false;
		}
	}

	/**
	 * Re-initialize indexes after health recovery.
	 * Re-runs the same configuration as init() (without throwing) and drains the write queue.
	 */
	private async reInit(): Promise<void> {
		try {
			const index = this.client.index(this.indexName);
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

			// Re-register userProvided embedder if applicable
			if (this.embeddingService) {
				try {
					await index.updateEmbedders({
						[EMBEDDER_NAME]: {
							source: "userProvided",
							dimensions: this.embeddingService.dimensions,
						},
					});
				} catch (err) {
					this.logger.warn("Failed to re-register embedder after recovery", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			this.logger.info("Re-initialized indexes after health recovery");

			// Attempt to drain the write queue
			await this.drainQueue();
		} catch (err) {
			this.logger.warn("Re-init after recovery failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			this.healthy = false;
		}
	}

	/** Cleanup — call when store is being shut down. Stops the health check timer. */
	destroy(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
	}

	/**
	 * Determine default scope for a memory category.
	 * `preference` and `fact` are global (cross-project).
	 * All other categories get "unscoped" — callers with project context
	 * (e.g. the MCP server via resolveStoreScope()) should set scope explicitly.
	 * Using "unscoped" rather than undefined ensures the field is always a string
	 * (required by Meilisearch filterable attributes).
	 */
	private defaultScopeForCategory(category: string): string {
		if (GLOBAL_SCOPE_CATEGORIES.has(category)) {
			return "global";
		}
		return "unscoped";
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
