/**
 * Analytics engine facade — adapts the @randal/analytics package API to the
 * synchronous `analyticsEngine` interface expected by the HTTP channel.
 *
 * Caches annotations and computed results with a short TTL to avoid hitting
 * Meilisearch on every HTTP request while keeping data reasonably fresh.
 */

import { randomUUID } from "node:crypto";
import {
	type AnnotationStore,
	computeReliabilityScores,
	computeTrends,
	generateRecommendations,
	getPrimaryDomain,
} from "@randal/analytics";
import type { Annotation, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import type { Runner } from "@randal/runner";

const logger = createLogger({ context: { component: "analytics-facade" } });

/** Cache TTL in milliseconds (60 seconds). */
const CACHE_TTL_MS = 60_000;

interface CachedData {
	annotations: Annotation[];
	fetchedAt: number;
}

export class AnalyticsEngineFacade {
	private store: AnnotationStore;
	private runner: Runner;
	private config: RandalConfig;
	private cache: CachedData | null = null;

	constructor(store: AnnotationStore, runner: Runner, config: RandalConfig) {
		this.store = store;
		this.runner = runner;
		this.config = config;
	}

	/** Refresh the annotation cache if stale. Runs synchronously from cached data. */
	private getCachedAnnotations(): Annotation[] {
		if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
			return this.cache.annotations;
		}
		// Return stale cache while kicking off a background refresh
		this.refreshCache();
		return this.cache?.annotations ?? [];
	}

	/** Background refresh — non-blocking. */
	private refreshCache(): void {
		this.store
			.list()
			.then((annotations) => {
				this.cache = { annotations, fetchedAt: Date.now() };
			})
			.catch((err) => {
				logger.warn("Failed to refresh annotation cache", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	/** Eagerly populate the cache on startup. */
	async warmup(): Promise<void> {
		try {
			const annotations = await this.store.list();
			this.cache = { annotations, fetchedAt: Date.now() };
		} catch {
			// Non-fatal — cache will be populated on first access
		}
	}

	getScores(): {
		overall: number;
		byAgent: Record<string, number>;
		byModel: Record<string, number>;
		byDomain: Record<string, number>;
	} | null {
		const annotations = this.getCachedAnnotations();
		const halfLife = this.config.analytics?.agingHalfLife ?? 30;
		const { scores, insufficientData } = computeReliabilityScores(annotations, {
			agingHalfLife: halfLife,
		});

		if (insufficientData) return null;

		const overall = scores.find((s) => s.dimension === "overall")?.passRate ?? 0;

		const byAgent: Record<string, number> = {};
		const byModel: Record<string, number> = {};
		const byDomain: Record<string, number> = {};

		for (const s of scores) {
			if (s.dimension === "agent") byAgent[s.value] = s.passRate;
			if (s.dimension === "model") byModel[s.value] = s.passRate;
			if (s.dimension === "domain") byDomain[s.value] = s.passRate;
		}

		return { overall, byAgent, byModel, byDomain };
	}

	getRecommendations(): Array<{
		severity: "info" | "warning" | "critical";
		message: string;
		action?: string;
	}> {
		const annotations = this.getCachedAnnotations();
		const halfLife = this.config.analytics?.agingHalfLife ?? 30;
		const { scores } = computeReliabilityScores(annotations, {
			agingHalfLife: halfLife,
		});
		const recs = generateRecommendations(scores, annotations);

		return recs.map((r) => ({
			severity: r.severity,
			message: r.message,
			action: r.type,
		}));
	}

	getTrends(range?: string): unknown {
		const annotations = this.getCachedAnnotations();
		const trends = computeTrends(annotations);

		return {
			sevenDay: trends.sevenDay,
			thirtyDay: trends.thirtyDay,
			range: range ?? "7d",
		};
	}

	getAnnotations(filters?: { jobId?: string; verdict?: string }): unknown[] {
		const annotations = this.getCachedAnnotations();

		let filtered = annotations;
		if (filters?.jobId) {
			filtered = filtered.filter((a) => a.jobId === filters.jobId);
		}
		if (filters?.verdict) {
			filtered = filtered.filter((a) => a.verdict === filters.verdict);
		}

		return filtered;
	}

	addAnnotation(
		jobId: string,
		input: { verdict: string; feedback?: string; categories?: string[] },
	): boolean {
		const job = this.runner.getJob(jobId);

		const annotation: Annotation = {
			id: randomUUID(),
			jobId,
			verdict: input.verdict as Annotation["verdict"],
			feedback: input.feedback,
			categories: input.categories,
			agent: job?.agent ?? "unknown",
			model: job?.model ?? "unknown",
			domain: job ? getPrimaryDomain(job.prompt) : "general",
			iterationCount: job?.iterations?.current ?? 1,
			tokenCost: job?.cost?.estimatedCost ?? 0,
			duration: job?.cost?.wallTime ?? 0,
			filesChanged:
				job?.iterations?.history?.flatMap((it: { filesChanged: string[] }) => it.filesChanged) ??
				[],
			prompt: job?.prompt ?? "",
			timestamp: new Date().toISOString(),
		};

		// Fire-and-forget save — the HTTP endpoint returns synchronously
		this.store.save(annotation).catch((err) => {
			logger.warn("Failed to save annotation", {
				error: err instanceof Error ? err.message : String(err),
				jobId,
			});
		});

		// Invalidate cache so next read picks up the new annotation
		this.cache = null;

		return true;
	}
}
