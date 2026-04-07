import type { MeshInstance, RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "posse-registry" } });

/**
 * Minimal Meilisearch-like client interface for registry operations.
 * Uses Record<string, unknown>[] for document arrays to be compatible with the real MeiliSearch client.
 */
export interface RegistryClient {
	index(name: string): {
		addDocuments(docs: Record<string, unknown>[]): Promise<unknown>;
		search(query: string, options?: Record<string, unknown>): Promise<{ hits: unknown[] }>;
		deleteDocument(id: string): Promise<unknown>;
	};
}

/** Registry document stored in the posse-registry-<posse-name> Meilisearch index. */
export interface RegistryDoc {
	id: string;
	name: string;
	posse: string;
	capabilities: string[];
	agent: string;
	status: "idle" | "busy" | "stale";
	version: string;
	lastHeartbeat: string;
	registeredAt: string;
	/** HTTP endpoint URL for this agent's gateway (e.g. "http://localhost:3100"). */
	endpoint?: string;
	/** Agent's domain specialization (e.g. "frontend", "backend", "devops"). */
	specialization?: string;
}

/** Stale threshold: agents with lastHeartbeat older than this are considered stale. */
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Build a registry document from config.
 */
export function buildRegistryDoc(
	config: RandalConfig,
	status: "idle" | "busy" = "idle",
): RegistryDoc {
	const now = new Date().toISOString();
	return {
		id: config.name,
		name: config.name,
		posse: config.posse ?? "",
		capabilities: config.tools.map((t) => t.name),
		agent: config.runner.defaultAgent,
		status,
		version: config.version,
		lastHeartbeat: now,
		registeredAt: now,
		endpoint: config.mesh.endpoint,
		specialization: config.mesh.specialization,
	};
}

/**
 * Build an updated heartbeat for an existing doc.
 */
export function buildHeartbeatUpdate(
	existingDoc: RegistryDoc,
	status?: "idle" | "busy",
): Partial<RegistryDoc> & { id: string } {
	return {
		id: existingDoc.id,
		lastHeartbeat: new Date().toISOString(),
		status: status ?? existingDoc.status,
	};
}

/**
 * Check if a registry document is stale (lastHeartbeat > 10 minutes ago).
 */
export function isStale(doc: RegistryDoc): boolean {
	const lastBeat = new Date(doc.lastHeartbeat).getTime();
	const now = Date.now();
	return now - lastBeat > STALE_THRESHOLD_MS;
}

/**
 * Mark stale entries in a list of registry docs (R3.6).
 * Returns new array with stale status applied where appropriate.
 */
export function markStaleEntries(docs: RegistryDoc[]): RegistryDoc[] {
	return docs.map((doc) => {
		if (isStale(doc) && doc.status !== "stale") {
			return { ...doc, status: "stale" as const };
		}
		return doc;
	});
}

/**
 * Get the registry index name for a posse.
 */
export function getRegistryIndexName(posseName: string): string {
	return `posse-registry-${posseName}`;
}

/**
 * Register an agent in the posse registry (Meilisearch).
 * Registration failure is non-fatal (R3.3).
 */
export async function registerAgent(config: RandalConfig, client: RegistryClient): Promise<void> {
	if (!config.posse) return;

	try {
		const indexName = getRegistryIndexName(config.posse);
		const doc = buildRegistryDoc(config);
		const index = client.index(indexName);
		await index.addDocuments([doc as unknown as Record<string, unknown>]);
		logger.info("Agent registered in posse registry", {
			agent: config.name,
			posse: config.posse,
		});
	} catch (err) {
		logger.warn("Failed to register in posse registry", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Update heartbeat in the posse registry.
 */
export async function updateHeartbeat(
	config: RandalConfig,
	client: RegistryClient,
	status?: "idle" | "busy",
): Promise<void> {
	if (!config.posse) return;

	try {
		const indexName = getRegistryIndexName(config.posse);
		const doc = buildRegistryDoc(config, status);
		doc.lastHeartbeat = new Date().toISOString();
		const index = client.index(indexName);
		await index.addDocuments([doc as unknown as Record<string, unknown>]);
	} catch (err) {
		logger.warn("Failed to update heartbeat in posse registry", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Query posse members from the registry.
 * Marks stale entries automatically (R3.6).
 */
export async function queryPosseMembers(
	config: RandalConfig,
	client: RegistryClient,
): Promise<RegistryDoc[]> {
	if (!config.posse) return [];

	try {
		const indexName = getRegistryIndexName(config.posse);
		const index = client.index(indexName);
		const results = await index.search("", { limit: 100 });
		const docs = results.hits as RegistryDoc[];
		return markStaleEntries(docs);
	} catch (err) {
		logger.warn("Failed to query posse members", {
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}

/**
 * Deregister an agent from the posse registry.
 * Failure is tolerable (R3.5).
 */
export async function deregisterAgent(config: RandalConfig, client: RegistryClient): Promise<void> {
	if (!config.posse) return;

	try {
		const indexName = getRegistryIndexName(config.posse);
		const index = client.index(indexName);
		await index.deleteDocument(config.name);
		logger.info("Agent deregistered from posse registry", {
			agent: config.name,
			posse: config.posse,
		});
	} catch (err) {
		logger.warn("Failed to deregister from posse registry", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Convert a RegistryDoc to a MeshInstance for use with the mesh router.
 * Fills defaults for fields that RegistryDoc does not track.
 */
export function registryDocToMeshInstance(doc: RegistryDoc): MeshInstance {
	const statusMap: Record<RegistryDoc["status"], MeshInstance["status"]> = {
		idle: "idle",
		busy: "busy",
		stale: "unhealthy",
	};

	return {
		instanceId: doc.id,
		name: doc.name,
		posse: doc.posse || undefined,
		capabilities: doc.capabilities,
		specialization: doc.specialization,
		status: statusMap[doc.status],
		lastHeartbeat: doc.lastHeartbeat,
		endpoint: doc.endpoint ?? "",
		models: [],
		activeJobs: 0,
		completedJobs: 0,
		health: {
			uptime: 0,
			missedPings: doc.status === "stale" ? 3 : 0,
		},
	};
}
