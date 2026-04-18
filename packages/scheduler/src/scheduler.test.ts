import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "@randal/core";
import type { Runner } from "@randal/runner";
import { setHeartbeatStateDir } from "./heartbeat.js";
import { Scheduler } from "./scheduler.js";

function createMockRunner() {
	return {
		execute: mock(() => Promise.resolve({})),
		getJob: mock(() => undefined),
		getActiveJobs: mock(() => []),
		stop: mock(() => false),
	} as unknown as Runner;
}

function createMinimalConfig(overrides: Record<string, unknown> = {}) {
	return configSchema.parse({
		name: "test-agent",
		runner: { workdir: "/tmp/test" },
		...overrides,
	});
}

describe("Scheduler", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "randal-scheduler-test-"));
		setHeartbeatStateDir(tempDir);
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("creates with minimal config (all defaults)", () => {
		const runner = createMockRunner();
		const config = createMinimalConfig();

		const scheduler = new Scheduler({ config, runner });

		const status = scheduler.getStatus();
		expect(status.heartbeat.tickCount).toBe(0);
		expect(status.cron).toHaveLength(0);
		expect(status.hooks.enabled).toBe(false);
	});

	test("starts and stops cleanly", async () => {
		const runner = createMockRunner();
		const config = createMinimalConfig({
			heartbeat: { enabled: true, every: "30m" },
		});

		const scheduler = new Scheduler({ config, runner });
		await scheduler.start();

		const status = scheduler.getStatus();
		expect(status.heartbeat.nextTick).not.toBeNull();

		scheduler.stop();

		const stoppedStatus = scheduler.getStatus();
		expect(stoppedStatus.heartbeat.nextTick).toBeNull();
	});

	test("provides access to heartbeat", () => {
		const runner = createMockRunner();
		const config = createMinimalConfig();

		const scheduler = new Scheduler({ config, runner });

		const heartbeat = scheduler.getHeartbeat();
		expect(heartbeat).toBeDefined();
		expect(heartbeat.getState().tickCount).toBe(0);
	});

	test("provides access to cron", () => {
		const runner = createMockRunner();
		const config = createMinimalConfig({
			cron: {
				jobs: {
					"test-job": {
						schedule: "0 8 * * *",
						prompt: "Test",
						execution: "isolated",
					},
				},
			},
		});

		const scheduler = new Scheduler({ config, runner });

		const cron = scheduler.getCron();
		expect(cron.listJobs()).toHaveLength(1);
	});

	test("provides hooks router", () => {
		const runner = createMockRunner();
		const config = createMinimalConfig({
			hooks: { enabled: true, token: "test" },
		});

		const scheduler = new Scheduler({ config, runner });

		const router = scheduler.getHooksRouter();
		expect(router).toBeDefined();
	});

	test("status includes all components", async () => {
		const runner = createMockRunner();
		const config = createMinimalConfig({
			heartbeat: { enabled: true, every: "15m" },
			cron: {
				jobs: {
					"job-a": {
						schedule: "0 8 * * *",
						prompt: "Job A",
						execution: "isolated",
					},
					"job-b": {
						schedule: { every: "1h" },
						prompt: "Job B",
						execution: "main",
					},
				},
			},
			hooks: { enabled: true, token: "secret" },
		});

		const scheduler = new Scheduler({ config, runner });
		await scheduler.start();

		const status = scheduler.getStatus();

		expect(status.heartbeat).toBeDefined();
		expect(status.heartbeat.nextTick).not.toBeNull();

		expect(status.cron).toHaveLength(2);

		expect(status.hooks.enabled).toBe(true);
		expect(status.hooks.pendingItems).toBe(0);

		scheduler.stop();
	});

	test("cron main-mode jobs route through heartbeat", async () => {
		const runner = createMockRunner();
		const config = createMinimalConfig({
			heartbeat: { enabled: true, every: "30m" },
			cron: {
				jobs: {
					"main-job": {
						schedule: { every: "100ms" },
						prompt: "Test main mode routing",
						execution: "main",
					},
				},
			},
		});

		const scheduler = new Scheduler({ config, runner });
		await scheduler.start();

		// Wait for cron to fire and triggerNow() to process the wake item
		await new Promise((r) => setTimeout(r, 250));

		// The wake item was queued then immediately processed via triggerNow(),
		// so the queue is drained. Verify the heartbeat tick ran (tickCount > 0)
		// and the runner was invoked with the cron prompt content.
		const heartbeatState = scheduler.getHeartbeat().getState();
		expect(heartbeatState.tickCount).toBeGreaterThanOrEqual(1);
		expect(runner.execute).toHaveBeenCalled();

		scheduler.stop();
	});
});
