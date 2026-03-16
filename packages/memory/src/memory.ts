import type { MemoryDoc, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import {
	type StoreFactory,
	defaultStoreFactory,
	publishToShared,
	searchCrossAgent,
} from "./cross-agent.js";
import { FileStore } from "./stores/file.js";
import type { MemoryStore } from "./stores/index.js";
import { MeilisearchStore } from "./stores/meilisearch.js";

export interface MemoryManagerOptions {
	config: RandalConfig;
	basePath?: string;
	/** Pre-built store instance. When provided, skips config-driven store construction. */
	store?: MemoryStore;
	/** Custom store factory for cross-agent operations. Enables testing without Meilisearch. */
	storeFactory?: StoreFactory;
}

export class MemoryManager {
	private store: MemoryStore;
	private config: RandalConfig;
	private storeFactory: StoreFactory;
	private logger = createLogger({ context: { component: "memory" } });

	constructor(options: MemoryManagerOptions) {
		this.config = options.config;
		this.storeFactory = options.storeFactory ?? defaultStoreFactory;

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

		// Publish to shared index if configured (R1.2)
		if (this.config.memory.sharing.publishTo) {
			try {
				await publishToShared(doc, this.config, this.storeFactory);
			} catch (err) {
				this.logger.warn("Failed to publish to shared index", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	async recent(limit?: number): Promise<MemoryDoc[]> {
		return this.store.recent(limit ?? 10);
	}

	/**
	 * Search and return formatted strings for prompt injection.
	 * Merges cross-agent results when sharing is configured (R1.1).
	 */
	async searchForContext(query: string): Promise<string[]> {
		const maxResults = this.config.memory.autoInject.maxResults;

		// Get own results
		const ownDocs = await this.search(query, maxResults);

		// Get cross-agent results if sharing is configured (R1.1)
		const readFrom = this.config.memory.sharing.readFrom;
		if (readFrom.length === 0) {
			// No sharing — identical to previous behavior (R1.7)
			return ownDocs.map((d) => `[${d.category}] ${d.content}`);
		}

		let crossDocs: MemoryDoc[] = [];
		try {
			crossDocs = await searchCrossAgent(query, this.config, maxResults, this.storeFactory);
		} catch (err) {
			this.logger.warn("Cross-agent search failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Merge and deduplicate by contentHash
		const seen = new Set<string>();
		const merged: Array<{ doc: MemoryDoc; isOwn: boolean }> = [];

		for (const doc of ownDocs) {
			if (doc.contentHash && seen.has(doc.contentHash)) continue;
			if (doc.contentHash) seen.add(doc.contentHash);
			merged.push({ doc, isOwn: true });
		}

		for (const doc of crossDocs) {
			if (doc.contentHash && seen.has(doc.contentHash)) continue;
			if (doc.contentHash) seen.add(doc.contentHash);
			merged.push({ doc, isOwn: false });
		}

		// Sort by timestamp descending and cap at maxResults
		merged.sort((a, b) => b.doc.timestamp.localeCompare(a.doc.timestamp));
		const capped = merged.slice(0, maxResults);

		// Format with agent attribution for foreign memories (R1.8)
		return capped.map(({ doc, isOwn }) => {
			if (isOwn || doc.source === "self") {
				return `[${doc.category}] ${doc.content}`;
			}
			const agentName = doc.source.startsWith("agent:") ? doc.source : `agent:${doc.source}`;
			return `[${doc.category}] (from ${agentName}) ${doc.content}`;
		});
	}
}
