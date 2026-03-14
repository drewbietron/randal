import { describe, expect, mock, test } from "bun:test";
import { matchesCronExpression } from "./cron.js";

describe("matchesCronExpression", () => {
	test("matches every minute (* * * * *)", () => {
		const date = new Date("2026-03-13T12:30:00Z");
		expect(matchesCronExpression("* * * * *", date)).toBe(true);
	});

	test("matches specific minute", () => {
		const date = new Date("2026-03-13T12:30:00Z");
		expect(matchesCronExpression("30 * * * *", date)).toBe(true);
		expect(matchesCronExpression("15 * * * *", date)).toBe(false);
	});

	test("matches specific hour and minute", () => {
		const date = new Date("2026-03-13T07:00:00Z");
		expect(matchesCronExpression("0 7 * * *", date)).toBe(true);
		expect(matchesCronExpression("0 8 * * *", date)).toBe(false);
	});

	test("matches day of week (Friday = 5)", () => {
		const friday = new Date("2026-03-13T12:00:00Z"); // Friday
		expect(matchesCronExpression("* * * * 5", friday)).toBe(true);
		expect(matchesCronExpression("* * * * 1", friday)).toBe(false);
	});

	test("matches day of week range (1-5 = Mon-Fri)", () => {
		const friday = new Date("2026-03-13T12:00:00Z"); // Friday
		expect(matchesCronExpression("0 18 * * 1-5", friday)).toBe(false); // wrong hour
	});

	test("matches weekday range at correct hour", () => {
		const fridayEvening = new Date("2026-03-13T18:00:00Z"); // Friday 18:00
		expect(matchesCronExpression("0 18 * * 1-5", fridayEvening)).toBe(true);
	});

	test("matches step expression (*/5)", () => {
		const date0 = new Date("2026-03-13T12:00:00Z");
		const date5 = new Date("2026-03-13T12:05:00Z");
		const date3 = new Date("2026-03-13T12:03:00Z");

		expect(matchesCronExpression("*/5 * * * *", date0)).toBe(true);
		expect(matchesCronExpression("*/5 * * * *", date5)).toBe(true);
		expect(matchesCronExpression("*/5 * * * *", date3)).toBe(false);
	});

	test("matches comma-separated list", () => {
		const date = new Date("2026-03-13T12:15:00Z");
		expect(matchesCronExpression("0,15,30,45 * * * *", date)).toBe(true);
		expect(matchesCronExpression("0,10,20,40 * * * *", date)).toBe(false);
	});

	test("matches month field", () => {
		const march = new Date("2026-03-13T12:00:00Z");
		expect(matchesCronExpression("* * * 3 *", march)).toBe(true);
		expect(matchesCronExpression("* * * 4 *", march)).toBe(false);
	});

	test("matches day of month", () => {
		const date = new Date("2026-03-13T12:00:00Z");
		expect(matchesCronExpression("* * 13 * *", date)).toBe(true);
		expect(matchesCronExpression("* * 14 * *", date)).toBe(false);
	});

	test("matches complex expression (0 9 * * 1)", () => {
		const mondayMorning = new Date("2026-03-16T09:00:00Z"); // Monday
		expect(matchesCronExpression("0 9 * * 1", mondayMorning)).toBe(true);

		const tuesdayMorning = new Date("2026-03-17T09:00:00Z"); // Tuesday
		expect(matchesCronExpression("0 9 * * 1", tuesdayMorning)).toBe(false);
	});

	test("handles Sunday as 0 and 7", () => {
		const sunday = new Date("2026-03-15T12:00:00Z"); // Sunday
		expect(matchesCronExpression("* * * * 0", sunday)).toBe(true);
		expect(matchesCronExpression("* * * * 7", sunday)).toBe(true);
	});

	test("rejects invalid format", () => {
		const date = new Date();
		expect(matchesCronExpression("invalid", date)).toBe(false);
		expect(matchesCronExpression("* * *", date)).toBe(false);
	});
});

describe("CronScheduler", () => {
	test("lists registered jobs", async () => {
		const { CronScheduler } = await import("./cron.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const scheduler = new CronScheduler({
			jobs: {
				"morning-briefing": {
					schedule: "0 8 * * *",
					prompt: "Morning briefing",
					execution: "isolated",
					announce: true,
				},
				"weekly-cleanup": {
					schedule: { every: "7d" },
					prompt: "Weekly cleanup",
					execution: "main",
					announce: false,
				},
			},
			runner: mockRunner,
		});

		const jobs = scheduler.listJobs();
		expect(jobs).toHaveLength(2);
		expect(jobs.find((j) => j.name === "morning-briefing")).toBeDefined();
		expect(jobs.find((j) => j.name === "weekly-cleanup")).toBeDefined();
	});

	test("gets specific job", async () => {
		const { CronScheduler } = await import("./cron.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const scheduler = new CronScheduler({
			jobs: {
				"test-job": {
					schedule: "0 8 * * *",
					prompt: "Test",
					execution: "isolated",
					announce: false,
				},
			},
			runner: mockRunner,
		});

		const job = scheduler.getJob("test-job");
		expect(job).toBeDefined();
		expect(job?.name).toBe("test-job");
		expect(job?.status).toBe("active");
		expect(job?.runCount).toBe(0);

		const missing = scheduler.getJob("nonexistent");
		expect(missing).toBeUndefined();
	});

	test("adds runtime job", async () => {
		const { CronScheduler } = await import("./cron.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const scheduler = new CronScheduler({
			jobs: {},
			runner: mockRunner,
		});

		expect(scheduler.listJobs()).toHaveLength(0);

		scheduler.addJob({
			name: "new-job",
			schedule: { every: "1h" },
			prompt: "Do something",
			execution: "isolated",
			announce: false,
		});

		expect(scheduler.listJobs()).toHaveLength(1);
		expect(scheduler.getJob("new-job")).toBeDefined();

		scheduler.stop();
	});

	test("removes job", async () => {
		const { CronScheduler } = await import("./cron.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const scheduler = new CronScheduler({
			jobs: {
				"to-remove": {
					schedule: "0 8 * * *",
					prompt: "Remove me",
					execution: "isolated",
					announce: false,
				},
			},
			runner: mockRunner,
		});

		expect(scheduler.listJobs()).toHaveLength(1);

		const removed = scheduler.removeJob("to-remove");
		expect(removed).toBe(true);
		expect(scheduler.listJobs()).toHaveLength(0);

		const removedAgain = scheduler.removeJob("to-remove");
		expect(removedAgain).toBe(false);
	});

	test("one-shot job past time is marked completed", async () => {
		const { CronScheduler } = await import("./cron.js");

		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const scheduler = new CronScheduler({
			jobs: {
				"past-job": {
					schedule: { at: "2020-01-01T00:00:00Z" },
					prompt: "Past job",
					execution: "isolated",
					announce: false,
				},
			},
			runner: mockRunner,
		});

		scheduler.start();

		const job = scheduler.getJob("past-job");
		expect(job?.status).toBe("completed");

		scheduler.stop();
	});

	test("emits events on add/remove", async () => {
		const { CronScheduler } = await import("./cron.js");

		const events: Array<{ type: string }> = [];
		const mockRunner = {
			execute: mock(() => Promise.resolve({})),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as import("@randal/runner").Runner;

		const scheduler = new CronScheduler({
			jobs: {},
			runner: mockRunner,
			onEvent: (event) => {
				events.push(event);
			},
		});

		scheduler.addJob({
			name: "event-test",
			schedule: { every: "1h" },
			prompt: "Test",
			execution: "isolated",
			announce: false,
		});

		expect(events.some((e) => e.type === "cron.added")).toBe(true);

		scheduler.removeJob("event-test");
		expect(events.some((e) => e.type === "cron.removed")).toBe(true);

		scheduler.stop();
	});

	test("main execution mode queues to heartbeat", async () => {
		const { CronScheduler } = await import("./cron.js");
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

		const scheduler = new CronScheduler({
			jobs: {},
			runner: mockRunner,
			heartbeat,
		});

		// Add a main-mode job with interval that fires quickly
		scheduler.addJob({
			name: "main-mode-test",
			schedule: { every: "100ms" },
			prompt: "Test main mode",
			execution: "main",
			announce: false,
		});

		scheduler.start();

		// Wait for the job to fire
		await new Promise((r) => setTimeout(r, 200));

		// Check that heartbeat has the queued item
		const state = heartbeat.getState();
		expect(state.pendingWakeItems.length).toBeGreaterThanOrEqual(1);
		expect(state.pendingWakeItems.some((item) => item.source === "cron")).toBe(true);

		scheduler.stop();
	});
});
