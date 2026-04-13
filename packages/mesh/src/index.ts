export {
	MemoryMeshRegistry,
	MeilisearchMeshRegistry,
	createInstanceFromConfig,
} from "./registry.js";
export type { MeshRegistryOptions, MeiliClient, ExpertiseOptions } from "./registry.js";

export { filterInstances, findBestForRole } from "./discovery.js";
export type { DiscoveryOptions, DiscoveryResult } from "./discovery.js";

export { routeTask, dryRunRoute, cosineSimilarity } from "./router.js";
export type { RoutingWeights, RoutingContext, RoutingDecision } from "./router.js";

export {
	HealthMonitor,
	checkHealth,
	evaluateHealth,
	UNHEALTHY_THRESHOLD,
	DEREGISTER_TIMEOUT_MS,
	HEALTH_CHECK_INTERVAL_MS,
} from "./health.js";
export type { HealthCheckResult } from "./health.js";
