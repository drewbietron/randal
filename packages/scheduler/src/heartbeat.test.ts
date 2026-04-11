import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { isWithinActiveHours, parseDuration, setHeartbeatStateDir } from "./heartbeat.js";

describe("parseDuration", () => {
	test("parses minutes", () => {
		expect(parseDuration("30m")).toBe(30 * 60 * 1000);
	});

	test("parses hours", () => {
		expect(parseDuration("1h")).toBe(60 * 60 * 1000);
	});

	test("parses seconds", () => {
		expect(parseDuration("45s")).toBe(45 * 1000);
	});

	test("parses days", () => {
		expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
	});

	test("parses milliseconds", () => {
		expect(parseDuration("500ms")).toBe(500);
	});

	test("parses compound durations", () => {
		expect(parseDuration("2h30m")).toBe(2 * 60 * 60 * 1000 + 30 * 60 * 1000);
	});

	test("parses 15m", () => {
		expect(parseDuration("15m")).toBe(15 * 60 * 1000);
	});

	test("throws on invalid input", () => {
		expect(() => parseDuration("invalid")).toThrow("Invalid duration string");
	});
});

describe("isWithinActiveHours", () => {
	test("returns true when no active hours configured", () => {
		expect(isWithinActiveHours(undefined)).toBe(true);
	});

	test("returns true when empty active hours", () => {
		expect(isWithinActiveHours({})).toBe(true);
	});

	test("returns true when no start or end", () => {
		expect(isWithinActiveHours({ timezone: "UTC" })).toBe(true);
	});

	test("returns true when within window (UTC)", () => {
		// Create a date at 12:00 UTC
		const noon = new Date("2026-03-13T12:00:00Z");
		expect(
			isWithinActiveHours(
				{
					start: "08:00",
					end: "22:00",
					timezone: "UTC",
				},
				noon,
			),
		).toBe(true);
	});

	test("returns false when before start (UTC)", () => {
		// Create a date at 06:00 UTC
		const early = new Date("2026-03-13T06:00:00Z");
		expect(
			isWithinActiveHours(
				{
					start: "08:00",
					end: "22:00",
					timezone: "UTC",
				},
				early,
			),
		).toBe(false);
	});

	test("returns false when after end (UTC)", () => {
		// Create a date at 23:00 UTC
		const late = new Date("2026-03-13T23:00:00Z");
		expect(
			isWithinActiveHours(
				{
					start: "08:00",
					end: "22:00",
					timezone: "UTC",
				},
				late,
			),
		).toBe(false);
	});

	test("respects start only", () => {
		const early = new Date("2026-03-13T06:00:00Z");
		expect(
			isWithinActiveHours(
				{
					start: "08:00",
					timezone: "UTC",
				},
				early,
			),
		).toBe(false);

		const late = new Date("2026-03-13T23:00:00Z");
		expect(
			isWithinActiveHours(
				{
					start: "08:00",
					timezone: "UTC",
				},
				late,
			),
		).toBe(true);
	});

	test("respects end only", () => {
		const early = new Date("2026-03-13T06:00:00Z");
		expect(
			isWithinActiveHours(
				{
					end: "22:00",
					timezone: "UTC",
				},
				early,
			),
		).toBe(true);

		const late = new Date("2026-03-13T23:00:00Z");
		expect(
			isWithinActiveHours(
				{
					end: "22:00",
					timezone: "UTC",
				},
				late,
			),
		).toBe(false);
	});
});

describe("Heartbeat", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "randal-heartbeat-test-"));
		setHeartbeatStateDir(tempDir);
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// Test wake item queueing
	test("queues and retrieves wake items", async () => {
		const { Heartbeat } = await import("./heartbeat.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "30m",
				prompt: "Test heartbeat prompt",
				target: "none",
			},
			runner: mockRunner,
		});

		heartbeat.queueWakeItem({
			text: "Test wake item",
			source: "hook",
			timestamp: new Date().toISOString(),
		});

		const state = heartbeat.getState();
		expect(state.pendingWakeItems).toHaveLength(1);
		expect(state.pendingWakeItems[0].text).toBe("Test wake item");
		expect(state.pendingWakeItems[0].source).toBe("hook");
	});

	test("initial state is correct", async () => {
		const { Heartbeat } = await import("./heartbeat.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "1h",
				prompt: "Check in",
				target: "none",
			},
			runner: mockRunner,
		});

		const state = heartbeat.getState();
		expect(state.lastTick).toBeNull();
		expect(state.nextTick).toBeNull();
		expect(state.tickCount).toBe(0);
		expect(state.pendingWakeItems).toHaveLength(0);
	});

	test("start sets nextTick", async () => {
		const { Heartbeat } = await import("./heartbeat.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "30m",
				prompt: "Check in",
				target: "none",
			},
			runner: mockRunner,
		});

		heartbeat.start();

		const state = heartbeat.getState();
		expect(state.nextTick).not.toBeNull();

		heartbeat.stop();
	});

	test("stop clears timer and nextTick", async () => {
		const { Heartbeat } = await import("./heartbeat.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "30m",
				prompt: "Check in",
				target: "none",
			},
			runner: mockRunner,
		});

		heartbeat.start();
		heartbeat.stop();

		const state = heartbeat.getState();
		expect(state.nextTick).toBeNull();
	});

	test("triggerNow runs even outside active hours", async () => {
		const { Heartbeat } = await import("./heartbeat.js");

		const executeMock = mock(() => Promise.resolve({}));
		const mockRunner = {
			execute: executeMock,
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "30m",
				prompt: "Test prompt inline",
				activeHours: {
					start: "00:00",
					end: "00:01", // Very narrow — almost always outside
					timezone: "UTC",
				},
				target: "none",
			},
			runner: mockRunner,
		});

		await heartbeat.triggerNow("urgent context");

		// Should have called execute even outside active hours
		expect(executeMock).toHaveBeenCalled();

		const state = heartbeat.getState();
		expect(state.tickCount).toBe(1);
		expect(state.lastTick).not.toBeNull();
	});

	test("emits events via onEvent", async () => {
		const { Heartbeat } = await import("./heartbeat.js");

		const events: Array<{ type: string }> = [];
		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "30m",
				prompt: "Check in prompt",
				target: "none",
			},
			runner: mockRunner,
			onEvent: (event) => {
				events.push(event);
			},
		});

		await heartbeat.triggerNow();

		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events.some((e) => e.type === "heartbeat.tick")).toBe(true);
	});

	test("clears wake items after tick", async () => {
		const { Heartbeat } = await import("./heartbeat.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "30m",
				prompt: "Check in prompt",
				target: "none",
			},
			runner: mockRunner,
		});

		heartbeat.queueWakeItem({
			text: "item 1",
			source: "hook",
			timestamp: new Date().toISOString(),
		});
		heartbeat.queueWakeItem({
			text: "item 2",
			source: "cron",
			timestamp: new Date().toISOString(),
		});

		expect(heartbeat.getState().pendingWakeItems).toHaveLength(2);

		await heartbeat.triggerNow();

		expect(heartbeat.getState().pendingWakeItems).toHaveLength(0);
	});

	test("runs catch-up tick when lastTick is stale", async () => {
		// Write a stale persisted state with lastTick 2 hours ago
		const staleState = {
			tickCount: 5,
			lastTick: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			wakeQueue: [],
		};
		writeFileSync(join(tempDir, "heartbeat-state.yaml"), stringifyYaml(staleState), "utf-8");

		const executeMock = mock(() => Promise.resolve({}));
		const mockRunner = {
			execute: executeMock,
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const { Heartbeat } = await import("./heartbeat.js");
		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "30m",
				prompt: "Check in",
				target: "none",
			},
			runner: mockRunner,
		});

		heartbeat.start();

		// Wait for the setTimeout(0) catch-up tick to fire
		await new Promise((r) => setTimeout(r, 200));

		expect(executeMock).toHaveBeenCalled();
		expect(heartbeat.getState().tickCount).toBe(6); // 5 restored + 1 catch-up

		heartbeat.stop();
	});

	test("does not run catch-up tick when lastTick is recent", async () => {
		// Write a recent persisted state (lastTick 5 minutes ago, interval 30m)
		const recentState = {
			tickCount: 5,
			lastTick: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
			wakeQueue: [],
		};
		writeFileSync(join(tempDir, "heartbeat-state.yaml"), stringifyYaml(recentState), "utf-8");

		const executeMock = mock(() => Promise.resolve({}));
		const mockRunner = {
			execute: executeMock,
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const { Heartbeat } = await import("./heartbeat.js");
		const heartbeat = new Heartbeat({
			config: {
				enabled: true,
				every: "30m",
				prompt: "Check in",
				target: "none",
			},
			runner: mockRunner,
		});

		heartbeat.start();

		// Wait a bit — no catch-up should fire
		await new Promise((r) => setTimeout(r, 200));

		// executeMock should NOT have been called (no catch-up needed)
		expect(executeMock).not.toHaveBeenCalled();
		expect(heartbeat.getState().tickCount).toBe(5); // unchanged

		heartbeat.stop();
	});
});
