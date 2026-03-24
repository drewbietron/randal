import type { MemoryDoc } from "@randal/core";

export interface MemoryStore {
	init(): Promise<void>;
	search(query: string, limit: number): Promise<MemoryDoc[]>;
	index(doc: Omit<MemoryDoc, "id">): Promise<void>;
	recent(limit: number): Promise<MemoryDoc[]>;
}

export { MeilisearchStore } from "./meilisearch.js";
