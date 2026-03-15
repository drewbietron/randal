import type { MemoryDoc, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import { FileStore } from "./stores/file.js";
import type { MemoryStore } from "./stores/index.js";
import { MeilisearchStore } from "./stores/meilisearch.js";

export interface MemoryManagerOptions {
	config: RandalConfig;
	basePath?: string;
	/** Pre-built store instance. When provided, skips config-driven store construction. */
	store?: MemoryStore;
}

export class MemoryManager {
	private store: MemoryStore;
	private config: RandalConfig;
	private logger = createLogger({ context: { component: "memory" } });

	constructor(options: MemoryManagerOptions) {
		this.config = options.config;

		if (options.store) {
			this.store = options.store;
		} else if (options.config.memory.store === "file") {
			this.store = new FileStore({
				basePath: options.basePath ?? ".",
				files: options.config.memory.files,
			});
		} else {
			this.store = new MeilisearchStore({
				url: options.config.memory.url,
				apiKey: options.config.memory.apiKey,
				index: options.config.memory.index ?? `memory-${options.config.name}`,
			});
		}
	}

	async init(): Promise<void> {
		try {
			await this.store.init();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (this.config.memory.store === "file") {
				throw new Error(`Memory initialization failed: ${msg}`);
			}
			throw new Error(
				`Meilisearch connection failed: ${msg}\nEnsure Meilisearch is running:\n  docker run -d -p 7700:7700 getmeili/meilisearch:latest\nOr configure memory.url and memory.apiKey in your config.`,
			);
		}
	}

	async search(query: string, limit?: number): Promise<MemoryDoc[]> {
		return this.store.search(query, limit ?? this.config.memory.autoInject.maxResults);
	}

	async index(doc: Omit<MemoryDoc, "id">): Promise<void> {
		await this.store.index(doc);
	}

	async recent(limit?: number): Promise<MemoryDoc[]> {
		return this.store.recent(limit ?? 10);
	}

	/**
	 * Search and return formatted strings for prompt injection.
	 */
	async searchForContext(query: string): Promise<string[]> {
		const docs = await this.search(query);
		return docs.map((d) => `[${d.category}] ${d.content}`);
	}
}
