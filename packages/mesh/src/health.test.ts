import { describe, expect, test } from "bun:test";
import type { MeshInstance } from "@randal/core";
import {
	DEREGISTER_TIMEOUT_MS,
	HEALTH_CHECK_INTERVAL_MS,
	HealthMonitor,
	UNHEALTHY_THRESHOLD,
	evaluateHealth,
} from "./health.js";

function makeInstance(overrides: Partial<MeshInstance> = {}): MeshInstance {
	return {
		instanceId: `inst-${Math.random().toString(36).slice(2, 8)}`,
		name: "test-agent",
		capabilities: ["run"],
		status: "idle",
		lastHeartbeat: new Date().toISOString(),
		endpoint: "http://localhost:7600",
		models: ["anthropic/claude-sonnet-4"],
		activeJobs: 0,
		completedJobs: 10,
		health: { uptime: 3600, missedPings: 0 },
		...overrides,
	};
}

describe("constants", () => {
	test("UNHEALTHY_THRESHOLD is 3", () => {
		expect(UNHEALTHY_THRESHOLD).toBe(3);
	});

	test("DEREGISTER_TIMEOUT_MS is 10 minutes", () => {
		expect(DEREGISTER_TIMEOUT_MS).toBe(10 * 60 * 1000);
	});

	test("HEALTH_CHECK_INTERVAL_MS is 60 seconds", () => {
		expect(HEALTH_CHECK_INTERVAL_MS).toBe(60 * 1000);
	});
});

describe("evaluateHealth", () => {
	test("returns current status for recent heartbeat", () => {
		const instance = makeInstance({
			status: "idle",
			lastHeartbeat: new Date().toISOString(),
		});

		const result = evaluateHealth(instance);
		expect(result.status).toBe("idle");
		expect(result.shouldDeregister).toBe(false);
	});

	test("preserves busy status for recent heartbeat", () => {
		const instance = makeInstance({
			status: "busy",
			lastHeartbeat: new Date().toISOString(),
		});

		const result = evaluateHealth(instance);
		expect(result.status).toBe("busy");
		expect(result.shouldDeregister).toBe(false);
	});

	test("returns unhealthy after UNHEALTHY_THRESHOLD missed pings", () => {
		const now = new Date();
		// 3 missed pings = 3 * 60s = 180s ago
		const missedTime = new Date(now.getTime() - UNHEALTHY_THRESHOLD * HEALTH_CHECK_INTERVAL_MS);

		const instance = makeInstance({
			status: "idle",
			lastHeartbeat: missedTime.toISOString(),
		});

		const result = evaluateHealth(instance, now);
		expect(result.status).toBe("unhealthy");
		expect(result.shouldDeregister).toBe(false);
	});

	test("returns shouldDeregister after DEREGISTER_TIMEOUT_MS", () => {
		const now = new Date();
		// More than 10 minutes ago
		const veryOld = new Date(now.getTime() - DEREGISTER_TIMEOUT_MS - 1000);

		const instance = makeInstance({
			status: "idle",
			lastHeartbeat: veryOld.toISOString(),
		});

		const result = evaluateHealth(instance, now);
		expect(result.status).toBe("offline");
		expect(result.shouldDeregister).toBe(true);
	});

	test("recovers unhealthy instance to idle when heartbeat is recent", () => {
		const instance = makeInstance({
			status: "unhealthy",
			lastHeartbeat: new Date().toISOString(),
		});

		const result = evaluateHealth(instance);
		expect(result.status).toBe("idle");
		expect(result.shouldDeregister).toBe(false);
	});

	test("does not recover to unhealthy when already unhealthy and still missing pings", () => {
		const now = new Date();
		const threeMissed = new Date(now.getTime() - UNHEALTHY_THRESHOLD * HEALTH_CHECK_INTERVAL_MS);

		const instance = makeInstance({
			status: "unhealthy",
			lastHeartbeat: threeMissed.toISOString(),
		});

		const result = evaluateHealth(instance, now);
		expect(result.status).toBe("unhealthy");
	});

	test("accepts custom now parameter", () => {
		const heartbeatTime = new Date("2025-01-01T00:00:00Z");
		const checkTime = new Date("2025-01-01T00:05:00Z"); // 5 min later

		const instance = makeInstance({
			status: "idle",
			lastHeartbeat: heartbeatTime.toISOString(),
		});

		const result = evaluateHealth(instance, checkTime);
		// 5 min = 300s, 300/60 = 5 missed pings > 3 threshold
		expect(result.status).toBe("unhealthy");
		expect(result.shouldDeregister).toBe(false);
	});

	test("does not deregister at exactly DEREGISTER_TIMEOUT_MS", () => {
		const now = new Date();
		const exactTimeout = new Date(now.getTime() - DEREGISTER_TIMEOUT_MS);

		const instance = makeInstance({
			status: "idle",
			lastHeartbeat: exactTimeout.toISOString(),
		});

		const result = evaluateHealth(instance, now);
		// At exactly the threshold, elapsed === timeout, not greater
		expect(result.shouldDeregister).toBe(false);
	});

	test("1 missed ping keeps current status", () => {
		const now = new Date();
		const oneMissed = new Date(now.getTime() - HEALTH_CHECK_INTERVAL_MS);

		const instance = makeInstance({
			status: "idle",
			lastHeartbeat: oneMissed.toISOString(),
		});

		const result = evaluateHealth(instance, now);
		expect(result.status).toBe("idle");
		expect(result.shouldDeregister).toBe(false);
	});

	test("2 missed pings keeps current status (below threshold)", () => {
		const now = new Date();
		const twoMissed = new Date(now.getTime() - 2 * HEALTH_CHECK_INTERVAL_MS);

		const instance = makeInstance({
			status: "idle",
			lastHeartbeat: twoMissed.toISOString(),
		});

		const result = evaluateHealth(instance, now);
		expect(result.status).toBe("idle");
		expect(result.shouldDeregister).toBe(false);
	});
});

describe("HealthMonitor", () => {
	test("tracks missed pings via getMissedPings", () => {
		const monitor = new HealthMonitor();

		// Initially should be 0
		expect(monitor.getMissedPings("inst-1")).toBe(0);
		expect(monitor.getMissedPings("unknown")).toBe(0);
	});

	test("stop on non-started monitor is safe", () => {
		const monitor = new HealthMonitor();
		// Should not throw
		monitor.stop();
	});

	test("start and stop lifecycle", async () => {
		const monitor = new HealthMonitor();
		const results: Array<{ instanceId: string; healthy: boolean }> = [];

		// Use a very short interval for testing
		monitor.start(
			async () => [],
			(result) => {
				results.push({ instanceId: result.instanceId, healthy: result.healthy });
			},
			50,
		);

		// Let it tick once
		await new Promise((resolve) => setTimeout(resolve, 100));

		monitor.stop();
		// Should not throw on double stop
		monitor.stop();
	});
});
