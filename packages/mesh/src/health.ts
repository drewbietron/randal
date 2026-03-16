/**
 * Health monitoring for the multi-instance mesh.
 * R4.4: Ping-based health checking with auto-deregistration.
 */

import type { MeshInstance } from "@randal/core";
import { createLogger } from "@randal/core";

const logger = createLogger({ context: { component: "mesh:health" } });

/** Mark unhealthy after this many missed pings */
export const UNHEALTHY_THRESHOLD = 3;

/** Auto-deregister after this many milliseconds of no heartbeat (10 minutes) */
export const DEREGISTER_TIMEOUT_MS = 10 * 60 * 1000;

/** Health check interval (60 seconds) */
export const HEALTH_CHECK_INTERVAL_MS = 60 * 1000;

export interface HealthCheckResult {
	instanceId: string;
	healthy: boolean;
	responseTimeMs?: number;
	error?: string;
}

/**
 * Perform a health check on a peer instance.
 */
export async function checkHealth(instance: MeshInstance): Promise<HealthCheckResult> {
	if (!instance.endpoint) {
		return {
			instanceId: instance.instanceId,
			healthy: false,
			error: "No endpoint configured",
		};
	}

	const start = Date.now();
	try {
		const url = `${instance.endpoint}/health`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);

		const response = await fetch(url, { signal: controller.signal });
		clearTimeout(timeout);

		const responseTimeMs = Date.now() - start;

		return {
			instanceId: instance.instanceId,
			healthy: response.ok,
			responseTimeMs,
			error: response.ok ? undefined : `HTTP ${response.status}`,
		};
	} catch (err) {
		return {
			instanceId: instance.instanceId,
			healthy: false,
			responseTimeMs: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Evaluate instance health based on missed ping count.
 */
export function evaluateHealth(
	instance: MeshInstance,
	now: Date = new Date(),
): { status: MeshInstance["status"]; shouldDeregister: boolean } {
	const lastBeat = new Date(instance.lastHeartbeat).getTime();
	const elapsed = now.getTime() - lastBeat;

	const missedPings = Math.floor(elapsed / HEALTH_CHECK_INTERVAL_MS);

	if (elapsed > DEREGISTER_TIMEOUT_MS) {
		return { status: "offline", shouldDeregister: true };
	}

	if (missedPings >= UNHEALTHY_THRESHOLD) {
		return { status: "unhealthy", shouldDeregister: false };
	}

	return {
		status: instance.status === "unhealthy" ? "idle" : instance.status,
		shouldDeregister: false,
	};
}

/**
 * Health monitor that periodically checks peers.
 */
export class HealthMonitor {
	private interval: ReturnType<typeof setInterval> | null = null;
	private missedPings: Map<string, number> = new Map();

	/**
	 * Start monitoring with a callback for health results.
	 */
	start(
		getInstances: () => Promise<MeshInstance[]>,
		onResult: (result: HealthCheckResult) => void,
		intervalMs: number = HEALTH_CHECK_INTERVAL_MS,
	): void {
		this.interval = setInterval(async () => {
			try {
				const instances = await getInstances();
				for (const instance of instances) {
					const result = await checkHealth(instance);
					onResult(result);

					if (!result.healthy) {
						const current = this.missedPings.get(instance.instanceId) ?? 0;
						this.missedPings.set(instance.instanceId, current + 1);
					} else {
						this.missedPings.set(instance.instanceId, 0);
					}
				}
			} catch (err) {
				logger.warn("Health check cycle failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}, intervalMs);

		logger.info("Health monitor started", { intervalMs });
	}

	/**
	 * Stop the health monitor.
	 */
	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		logger.info("Health monitor stopped");
	}

	/**
	 * Get missed ping count for an instance.
	 */
	getMissedPings(instanceId: string): number {
		return this.missedPings.get(instanceId) ?? 0;
	}
}
