import { randomUUID } from "node:crypto";
import type { MessageDoc, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeiliSearch } from "meilisearch";

export interface MessageManagerOptions {
	config: RandalConfig;
	/** Override the Meilisearch index name. Defaults to `messages-{config.name}`. */
	indexName?: string;
}

export class MessageManager {
	private client: MeiliSearch;
	private indexName: string;
	private logger = createLogger({ context: { component: "messages" } });

	constructor(options: MessageManagerOptions) {
		this.client = new MeiliSearch({
			host: options.config.memory.url,
			apiKey: options.config.memory.apiKey,
		});
		this.indexName = options.indexName ?? `messages-${options.config.name}`;
	}

	async init(): Promise<void> {
		try {
			const index = this.client.index(this.indexName);

			await index.updateSearchableAttributes(["content", "speaker", "channel", "threadId"]);
			await index.updateFilterableAttributes([
				"threadId",
				"speaker",
				"channel",
				"jobId",
				"pendingAction",
				"timestamp",
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
	}

	/** Add a message to the history. */
	async add(doc: Omit<MessageDoc, "id">): Promise<string> {
		const id = randomUUID();
		const fullDoc: MessageDoc = { ...doc, id };

		try {
			const index = this.client.index(this.indexName);
			await index.addDocuments([fullDoc]);
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

	/** Full-text search across all messages. */
	async search(query: string, limit = 20): Promise<MessageDoc[]> {
		try {
			const index = this.client.index(this.indexName);
			const results = await index.search(query, {
				limit,
				sort: ["timestamp:desc"],
			});
			return results.hits as unknown as MessageDoc[];
		} catch (err) {
			this.logger.error("Message search failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
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
