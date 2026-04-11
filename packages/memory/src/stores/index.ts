import type { MemoryDoc } from "@randal/core";

export interface MemorySearchOptions {
	scope?: string;
}

export type IndexResult =
	| { status: "success" }
	| { status: "duplicate"; contentHash: string }
	| { status: "queued"; reason: string }
	| { status: "failed"; error: string };

export interface MemoryStore {
	init(): Promise<void>;
	search(query: string, limit: number, options?: MemorySearchOptions): Promise<MemoryDoc[]>;
	index(doc: Omit<MemoryDoc, "id">): Promise<IndexResult>;
	recent(limit: number): Promise<MemoryDoc[]>;
	/** Optional: check if the store backend is reachable. */
	isHealthy?(): boolean;
}

export { MeilisearchStore } from "./meilisearch.js";
