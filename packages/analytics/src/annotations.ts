/**
 * Annotation storage and retrieval for the self-learning system.
 * R5.2: Stores annotations linked to job metadata.
 */

import type { Annotation, AnnotationVerdict } from "@randal/core";
import { createLogger } from "@randal/core";
import { z } from "zod";

const logger = createLogger({ context: { component: "analytics:annotations" } });

export const annotationInputSchema = z.object({
	verdict: z.enum(["pass", "fail", "partial"]),
	feedback: z.string().optional(),
	categories: z.array(z.string()).optional(),
});

export type AnnotationInput = z.infer<typeof annotationInputSchema>;

export interface AnnotationStore {
	save(annotation: Annotation): Promise<void>;
	getByJobId(jobId: string): Promise<Annotation | null>;
	list(filters?: AnnotationFilters): Promise<Annotation[]>;
	count(): Promise<number>;
}

export interface AnnotationFilters {
	verdict?: AnnotationVerdict;
	agent?: string;
	model?: string;
	domain?: string;
	since?: string;
	limit?: number;
}

/**
 * In-memory annotation store (also supports Meilisearch backing).
 */
export class MemoryAnnotationStore implements AnnotationStore {
	private annotations: Map<string, Annotation> = new Map();

	async save(annotation: Annotation): Promise<void> {
		this.annotations.set(annotation.id, annotation);
		logger.debug("Annotation saved", {
			id: annotation.id,
			jobId: annotation.jobId,
			verdict: annotation.verdict,
		});
	}

	async getByJobId(jobId: string): Promise<Annotation | null> {
		for (const ann of this.annotations.values()) {
			if (ann.jobId === jobId) return ann;
		}
		return null;
	}

	async list(filters?: AnnotationFilters): Promise<Annotation[]> {
		let results = [...this.annotations.values()];

		if (filters?.verdict) {
			results = results.filter((a) => a.verdict === filters.verdict);
		}
		if (filters?.agent) {
			results = results.filter((a) => a.agent === filters.agent);
		}
		if (filters?.model) {
			results = results.filter((a) => a.model === filters.model);
		}
		if (filters?.domain) {
			results = results.filter((a) => a.domain === filters.domain);
		}
		if (filters?.since) {
			const sinceDate = new Date(filters.since).getTime();
			results = results.filter((a) => new Date(a.timestamp).getTime() >= sinceDate);
		}

		// Sort by timestamp descending
		results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		if (filters?.limit) {
			results = results.slice(0, filters.limit);
		}

		return results;
	}

	async count(): Promise<number> {
		return this.annotations.size;
	}
}

/**
 * Meilisearch-backed annotation store.
 */
export class MeilisearchAnnotationStore implements AnnotationStore {
	private client: { index: (name: string) => MeiliIndex };
	private indexName: string;

	constructor(client: { index: (name: string) => MeiliIndex }, instanceName: string) {
		this.client = client;
		this.indexName = `randal-annotations-${instanceName}`;
	}

	async init(): Promise<void> {
		try {
			const index = this.client.index(this.indexName);
			await index.updateFilterableAttributes(["verdict", "agent", "model", "domain", "timestamp"]);
			await index.updateSortableAttributes(["timestamp"]);
		} catch (err) {
			logger.warn("Failed to configure annotation index", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async save(annotation: Annotation): Promise<void> {
		try {
			const index = this.client.index(this.indexName);
			await index.addDocuments([annotation]);
		} catch (err) {
			logger.warn("Failed to save annotation to Meilisearch", {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	}

	async getByJobId(jobId: string): Promise<Annotation | null> {
		try {
			const index = this.client.index(this.indexName);
			const results = await index.search("", {
				filter: `jobId = "${jobId}"`,
				limit: 1,
			});
			return (results.hits[0] as Annotation) ?? null;
		} catch {
			return null;
		}
	}

	async list(filters?: AnnotationFilters): Promise<Annotation[]> {
		try {
			const index = this.client.index(this.indexName);
			const filterClauses: string[] = [];

			if (filters?.verdict) filterClauses.push(`verdict = "${filters.verdict}"`);
			if (filters?.agent) filterClauses.push(`agent = "${filters.agent}"`);
			if (filters?.model) filterClauses.push(`model = "${filters.model}"`);
			if (filters?.domain) filterClauses.push(`domain = "${filters.domain}"`);
			if (filters?.since) {
				filterClauses.push(`timestamp >= "${filters.since}"`);
			}

			const results = await index.search("", {
				filter: filterClauses.length > 0 ? filterClauses.join(" AND ") : undefined,
				sort: ["timestamp:desc"],
				limit: filters?.limit ?? 1000,
			});

			return results.hits as Annotation[];
		} catch {
			return [];
		}
	}

	async count(): Promise<number> {
		try {
			const index = this.client.index(this.indexName);
			const stats = await index.getStats();
			return stats.numberOfDocuments;
		} catch {
			return 0;
		}
	}
}

// Minimal Meilisearch index interface for typing
interface MeiliIndex {
	addDocuments(docs: unknown[]): Promise<unknown>;
	search(
		query: string,
		options?: {
			filter?: string;
			sort?: string[];
			limit?: number;
		},
	): Promise<{ hits: unknown[] }>;
	getStats(): Promise<{ numberOfDocuments: number }>;
	updateFilterableAttributes(attrs: string[]): Promise<unknown>;
	updateSortableAttributes(attrs: string[]): Promise<unknown>;
}
