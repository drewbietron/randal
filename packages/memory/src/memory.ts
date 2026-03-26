import type { MemoryDoc, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import {
	type StoreFactory,
	defaultStoreFactory,
	publishToShared,
	searchCrossAgent,
} from "./cross-agent.js";
import type { MemorySearchOptions, MemoryStore } from "./stores/index.js";
import type { EmbedderConfig } from "./stores/meilisearch.js";
import { MeilisearchStore } from "./stores/meilisearch.js";

/** Categories that default to global scope (cross-project). */
const GLOBAL_SCOPE_CATEGORIES = new Set(["preference", "fact"]);

export interface MemoryManagerOptions {
	config: RandalConfig;
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
		} else {
			const embedder = this.resolveEmbedderConfig(options.config);
			this.store = new MeilisearchStore({
				url: options.config.memory.url,
				apiKey: options.config.memory.apiKey,
				index: options.config.memory.index ?? `memory-${options.config.name}`,
				embedder,
				semanticRatio: options.config.memory.semanticRatio,
			});
		}
	}

	async init(): Promise<void> {
		try {
			await this.store.init();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Meilisearch connection failed: ${msg}\nEnsure Meilisearch is running (auto-installed on first \`randal serve\`).\nOr start manually: brew install meilisearch && meilisearch`,
			);
		}
	}

	async search(query: string, limit?: number, options?: MemorySearchOptions): Promise<MemoryDoc[]> {
		return this.store.search(query, limit ?? this.config.memory.autoInject.maxResults, options);
	}

	async index(doc: Omit<MemoryDoc, "id">): Promise<void> {
		// Assign default scope if not explicitly provided by the caller.
		// preference/fact → global; everything else → global (callers with project
		// context should set scope explicitly before calling index).
		const scopedDoc: Omit<MemoryDoc, "id"> = doc.scope
			? doc
			: { ...doc, scope: GLOBAL_SCOPE_CATEGORIES.has(doc.category) ? "global" : "global" };

		await this.store.index(scopedDoc);

		// Publish to shared index if configured (R1.2)
		if (this.config.memory.sharing.publishTo) {
			try {
				await publishToShared(scopedDoc, this.config, this.storeFactory);
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
	async searchForContext(query: string, options?: MemorySearchOptions): Promise<string[]> {
		const maxResults = this.config.memory.autoInject.maxResults;

		// Get own results
		const ownDocs = await this.search(query, maxResults, options);

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

	/**
	 * Extract an EmbedderConfig from the RandalConfig if the embedder type
	 * supports external API calls. Returns undefined for "builtin" type
	 * (which uses Meilisearch's own embedder and has no external API to call).
	 */
	private resolveEmbedderConfig(config: RandalConfig): EmbedderConfig | undefined {
		const embedder = config.memory.embedder;

		if (embedder.type === "openrouter") {
			return {
				type: embedder.type,
				model: embedder.model,
				apiKey: embedder.apiKey,
				url: embedder.url,
			};
		}

		// "builtin", "openai", "ollama" — not wired up to MeilisearchStore's REST embedder yet.
		// The store falls back to keyword-only search when no embedder config is provided.
		return undefined;
	}
}
