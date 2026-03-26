import { randomUUID } from "node:crypto";
import type { MessageDoc, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeiliSearch } from "meilisearch";
import type { EmbedderConfig } from "./stores/meilisearch.js";

export interface MessageManagerOptions {
	config: RandalConfig;
	/** Override the Meilisearch index name. Defaults to `messages-{config.name}`. */
	indexName?: string;
	/** Embedder config for semantic search. If omitted, keyword-only search is used. */
	embedder?: EmbedderConfig;
	/** Semantic ratio for hybrid search (0 = keyword only, 1 = semantic only). Default: 0.7 */
	semanticRatio?: number;
}

export interface MessageSearchOptions {
	/** Filter by scope: "global", "project:/path", or undefined (no filter). */
	scope?: string;
	/** Filter by document type: "message" or "summary". */
	type?: "message" | "summary";
}

const EMBEDDER_NAME = "chat-embedder";
const DEFAULT_SEMANTIC_RATIO = 0.7;

export class MessageManager {
	private client: MeiliSearch;
	private indexName: string;
	private embedderConfig?: EmbedderConfig;
	private semanticRatio: number;
	private semanticAvailable = false;
	private logger = createLogger({ context: { component: "messages" } });

	constructor(options: MessageManagerOptions) {
		this.client = new MeiliSearch({
			host: options.config.memory.url,
			apiKey: options.config.memory.apiKey,
		});
		this.indexName = options.indexName ?? `messages-${options.config.name}`;
		this.embedderConfig = options.embedder;
		this.semanticRatio = options.semanticRatio ?? DEFAULT_SEMANTIC_RATIO;
	}

	async init(): Promise<void> {
		try {
			// Explicitly create the index with primaryKey='id' to avoid ambiguity
			// (MessageDoc has multiple *Id fields: id, threadId, jobId)
			await this.client.createIndex(this.indexName, { primaryKey: "id" }).catch(() => {
				// Index may already exist — that's fine
			});
			const index = this.client.index(this.indexName);

			// Ensure the primary key is set on existing indexes too
			await index.update({ primaryKey: "id" });

			await index.updateSearchableAttributes([
				"content",
				"summary",
				"topicKeywords",
				"speaker",
				"channel",
				"threadId",
			]);
			await index.updateFilterableAttributes([
				"threadId",
				"speaker",
				"channel",
				"jobId",
				"pendingAction",
				"timestamp",
				"scope",
				"type",
			]);
			await index.updateSortableAttributes(["timestamp"]);

			this.logger.info("Message history index initialized", {
				index: this.indexName,
			});
		} catch (err) {
			this.logger.error("Failed to initialize message history index", {
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
						documentTemplate: "A chat message: {{doc.content}}",
					},
				});
				this.semanticAvailable = true;
				this.logger.info("Chat semantic search enabled", {
					embedder: EMBEDDER_NAME,
					model: this.embedderConfig.model,
					semanticRatio: this.semanticRatio,
				});
			} catch (err) {
				this.semanticAvailable = false;
				this.logger.warn(
					"Failed to configure chat embedder — falling back to keyword-only search",
					{
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}
	}

	/** Add a message to the history. Waits for Meilisearch to finish indexing. */
	async add(doc: Omit<MessageDoc, "id">): Promise<string> {
		const id = randomUUID();
		const fullDoc: MessageDoc = { ...doc, id };

		try {
			const index = this.client.index(this.indexName);
			const task = await index.addDocuments([fullDoc]);
			// Wait for indexing so the message is searchable immediately
			// and survives a gateway crash right after logging
			await this.client.waitForTask(task.taskUid, { timeOutMs: 5000 });
			this.logger.info("Message saved", {
				threadId: doc.threadId,
				speaker: doc.speaker,
				channel: doc.channel,
			});
		} catch (err) {
			this.logger.error("Failed to save message", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		return id;
	}

	/** Search messages with optional semantic/hybrid mode and scope/type filtering. */
	async search(
		query: string,
		limit = 20,
		options?: MessageSearchOptions,
	): Promise<MessageDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const filters = this.buildFilters(options);

			if (this.semanticAvailable) {
				// Hybrid search: Meilisearch uses its own relevance ranking,
				// sort is not compatible with hybrid search
				const results = await index.search(query, {
					limit,
					hybrid: {
						embedder: EMBEDDER_NAME,
						semanticRatio: this.semanticRatio,
					},
					...(filters ? { filter: filters } : {}),
				});
				return results.hits as unknown as MessageDoc[];
			}

			// Keyword-only fallback with timestamp sort
			const results = await index.search(query, {
				limit,
				sort: ["timestamp:desc"],
				...(filters ? { filter: filters } : {}),
			});
			return results.hits as unknown as MessageDoc[];
		} catch (err) {
			this.logger.error("Message search failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/** Build Meilisearch filter string from search options. */
	private buildFilters(options?: MessageSearchOptions): string | undefined {
		if (!options) return undefined;

		const parts: string[] = [];

		if (options.scope) {
			parts.push(`scope = "${options.scope}"`);
		}
		if (options.type) {
			parts.push(`type = "${options.type}"`);
		}

		return parts.length > 0 ? parts.join(" AND ") : undefined;
	}

	/** Get messages for a specific thread, ordered chronologically. */
	async thread(threadId: string, limit = 50): Promise<MessageDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const results = await index.search("", {
				filter: `threadId = "${threadId}"`,
				limit,
				sort: ["timestamp:asc"],
			});
			return results.hits as unknown as MessageDoc[];
		} catch (err) {
			this.logger.error("Thread fetch failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/** Get recent messages across all threads. */
	async recent(limit = 20): Promise<MessageDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const results = await index.search("", {
				limit,
				sort: ["timestamp:desc"],
			});
			return results.hits as unknown as MessageDoc[];
		} catch (err) {
			this.logger.error("Recent messages query failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/** Get all messages with a pending action (not yet resolved). */
	async pending(limit = 20): Promise<MessageDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const results = await index.search("", {
				filter: 'pendingAction EXISTS AND pendingAction != ""',
				limit,
				sort: ["timestamp:desc"],
			});
			return results.hits as unknown as MessageDoc[];
		} catch (err) {
			this.logger.error("Pending actions query failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/** Get all unique threadIds that have recent messages, for startup preloading. */
	async recentThreadIds(limit = 100): Promise<string[]> {
		try {
			const index = this.client.index(this.indexName);
			// Fetch recent messages and extract unique threadIds
			const results = await index.search("", {
				limit,
				sort: ["timestamp:desc"],
			});
			const seen = new Set<string>();
			for (const hit of results.hits) {
				const doc = hit as unknown as MessageDoc;
				if (doc.threadId) seen.add(doc.threadId);
			}
			return [...seen];
		} catch (err) {
			this.logger.error("Failed to fetch recent threadIds", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/** Clear the pending action on a message (mark it resolved). */
	async resolvePending(messageId: string): Promise<void> {
		try {
			const index = this.client.index(this.indexName);
			await index.updateDocuments([{ id: messageId, pendingAction: "" }]);
		} catch (err) {
			this.logger.error("Failed to resolve pending action", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
