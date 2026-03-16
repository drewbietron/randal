/**
 * Instance discovery for the multi-instance mesh.
 * R4.3: Query the registry to find peers.
 */

import type { MeshInstance } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "mesh:discovery" } });

export interface DiscoveryOptions {
	posse?: string;
	specialization?: string;
	status?: MeshInstance["status"];
	excludeInstanceId?: string;
}

export interface DiscoveryResult {
	instances: MeshInstance[];
	total: number;
	healthy: number;
	busy: number;
}

/**
 * Query the registry for available peer instances.
 */
export function filterInstances(
	allInstances: MeshInstance[],
	options: DiscoveryOptions = {},
): DiscoveryResult {
	let instances = [...allInstances];

	// Exclude self
	if (options.excludeInstanceId) {
		instances = instances.filter((i) => i.instanceId !== options.excludeInstanceId);
	}

	// Filter by posse
	if (options.posse) {
		instances = instances.filter((i) => i.posse === options.posse);
	}

	// Filter by specialization
	if (options.specialization) {
		instances = instances.filter((i) => i.specialization === options.specialization);
	}

	// Filter by status
	if (options.status) {
		instances = instances.filter((i) => i.status === options.status);
	}

	const healthy = instances.filter(
		(i) => i.status !== "unhealthy" && i.status !== "offline",
	).length;
	const busy = instances.filter((i) => i.status === "busy").length;

	logger.debug("Discovery query completed", {
		total: instances.length,
		healthy,
		busy,
		filters: options,
	});

	return {
		instances,
		total: instances.length,
		healthy,
		busy,
	};
}

/**
 * Find the best instance for a given specialization.
 * Returns null if no suitable instance found.
 */
export function findBestForSpecialization(
	instances: MeshInstance[],
	specialization: string,
): MeshInstance | null {
	const matching = instances.filter(
		(i) =>
			i.specialization === specialization && i.status !== "unhealthy" && i.status !== "offline",
	);

	if (matching.length === 0) return null;

	// Prefer idle over busy
	const idle = matching.filter((i) => i.status === "idle");
	if (idle.length > 0) {
		return idle.reduce((a, b) => (a.activeJobs <= b.activeJobs ? a : b));
	}

	// All busy — pick least loaded
	return matching.reduce((a, b) => (a.activeJobs <= b.activeJobs ? a : b));
}
