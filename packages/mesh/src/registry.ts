/**
 * Instance registry for the multi-instance mesh.
 * R4.2: Instance registration in Meilisearch.
 */

import { randomBytes } from "node:crypto";
import type { MeshInstance, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "mesh:registry" } });

export interface MeshRegistryOptions {
	config: RandalConfig;
	/** Meilisearch client (optional — mesh works without it for testing) */
	client?: MeiliClient;
}

// Minimal Meilisearch client interface
export interface MeiliClient {
	index(name: string): MeiliIndex;
}

interface MeiliIndex {
	addDocuments(docs: unknown[]): Promise<unknown>;
	updateDocuments(docs: unknown[]): Promise<unknown>;
	deleteDocument(id: string): Promise<unknown>;
	search(
		query: string,
		options?: { filter?: string; limit?: number },
	): Promise<{ hits: unknown[] }>;
	getStats(): Promise<{ numberOfDocuments: number }>;
	updateFilterableAttributes(attrs: string[]): Promise<unknown>;
	updateSortableAttributes(attrs: string[]): Promise<unknown>;
}

/**
 * In-memory mesh registry for testing and single-instance mode.
 */
export class MemoryMeshRegistry {
	private instances: Map<string, MeshInstance> = new Map();

	async register(instance: MeshInstance): Promise<void> {
		this.instances.set(instance.instanceId, instance);
		logger.debug("Instance registered (memory)", { instanceId: instance.instanceId });
	}

	async deregister(instanceId: string): Promise<void> {
		this.instances.delete(instanceId);
		logger.debug("Instance deregistered (memory)", { instanceId });
	}

	async updateHeartbeat(
		instanceId: string,
		status: MeshInstance["status"],
		activeJobs: number,
	): Promise<void> {
		const instance = this.instances.get(instanceId);
		if (instance) {
			instance.lastHeartbeat = new Date().toISOString();
			instance.status = status;
			instance.activeJobs = activeJobs;
		}
	}

	async discover(options?: {
		posse?: string;
		specialization?: string;
		status?: MeshInstance["status"];
	}): Promise<MeshInstance[]> {
		let results = [...this.instances.values()];

		if (options?.posse) {
			results = results.filter((i) => i.posse === options.posse);
		}
		if (options?.specialization) {
			results = results.filter((i) => i.specialization === options.specialization);
		}
		if (options?.status) {
			results = results.filter((i) => i.status === options.status);
		}

		return results;
	}

	async get(instanceId: string): Promise<MeshInstance | null> {
		return this.instances.get(instanceId) ?? null;
	}

	async count(): Promise<number> {
		return this.instances.size;
	}

	/**
	 * Remove instances that haven't sent a heartbeat in the given timeout.
	 */
	async cleanupStale(timeoutMs: number): Promise<string[]> {
		const now = Date.now();
		const removed: string[] = [];

		for (const [id, instance] of this.instances) {
			const lastBeat = new Date(instance.lastHeartbeat).getTime();
			if (now - lastBeat > timeoutMs) {
				this.instances.delete(id);
				removed.push(id);
			}
		}

		if (removed.length > 0) {
			logger.info("Stale instances removed", { count: removed.length, ids: removed });
		}

		return removed;
	}
}

/**
 * Meilisearch-backed mesh registry.
 */
export class MeilisearchMeshRegistry {
	private client: MeiliClient;
	private indexName: string;

	constructor(client: MeiliClient, posse: string) {
		this.client = client;
		this.indexName = `randal-mesh-${posse}`;
	}

	async init(): Promise<void> {
		try {
			const index = this.client.index(this.indexName);
			await index.updateFilterableAttributes([
				"posse",
				"specialization",
				"status",
				"lastHeartbeat",
			]);
			await index.updateSortableAttributes(["lastHeartbeat"]);
		} catch (err) {
			logger.warn("Failed to configure mesh index", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async register(instance: MeshInstance): Promise<void> {
		const index = this.client.index(this.indexName);
		await index.addDocuments([{ ...instance, id: instance.instanceId }]);
		logger.info("Instance registered", { instanceId: instance.instanceId });
	}

	async deregister(instanceId: string): Promise<void> {
		const index = this.client.index(this.indexName);
		await index.deleteDocument(instanceId);
		logger.info("Instance deregistered", { instanceId });
	}

	async updateHeartbeat(
		instanceId: string,
		status: MeshInstance["status"],
		activeJobs: number,
	): Promise<void> {
		const index = this.client.index(this.indexName);
		await index.updateDocuments([
			{
				id: instanceId,
				lastHeartbeat: new Date().toISOString(),
				status,
				activeJobs,
			},
		]);
	}

	async discover(options?: {
		posse?: string;
		specialization?: string;
		status?: MeshInstance["status"];
	}): Promise<MeshInstance[]> {
		const index = this.client.index(this.indexName);
		const filters: string[] = [];

		if (options?.posse) filters.push(`posse = "${options.posse}"`);
		if (options?.specialization) filters.push(`specialization = "${options.specialization}"`);
		if (options?.status) filters.push(`status = "${options.status}"`);

		const result = await index.search("", {
			filter: filters.length > 0 ? filters.join(" AND ") : undefined,
			limit: 100,
		});

		return result.hits as MeshInstance[];
	}

	async get(instanceId: string): Promise<MeshInstance | null> {
		const index = this.client.index(this.indexName);
		const result = await index.search("", {
			filter: `instanceId = "${instanceId}"`,
			limit: 1,
		});
		return (result.hits[0] as MeshInstance) ?? null;
	}
}

/**
 * Create a MeshInstance object from config.
 */
export function createInstanceFromConfig(config: RandalConfig): MeshInstance {
	return {
		instanceId: randomBytes(8).toString("hex"),
		name: config.name,
		posse: config.posse,
		capabilities: ["run", "delegate"],
		specialization: config.mesh.specialization,
		status: "idle",
		lastHeartbeat: new Date().toISOString(),
		endpoint: config.mesh.endpoint ?? "",
		models: [config.runner.defaultModel],
		activeJobs: 0,
		completedJobs: 0,
		health: { uptime: 0, missedPings: 0 },
	};
}
