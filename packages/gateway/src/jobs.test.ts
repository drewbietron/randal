import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Job } from "@randal/core";
import { listJobs, loadJob, saveJob, updateJob } from "./jobs.js";

function makeJob(id: string, status: Job["status"] = "running"): Job {
	return {
		id,
		status,
		prompt: "test prompt",
		agent: "mock",
		model: "test-model",
		maxIterations: 5,
		workdir: "/tmp",
		createdAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		completedAt: null,
		duration: null,
		iterations: { current: 0, history: [] },
		plan: [],
		cost: { totalTokens: { input: 0, output: 0 }, estimatedCost: 0, wallTime: 0 },
		updates: [],
		error: null,
		exitCode: null,
	};
}

describe("jobs", () => {
	const testIds: string[] = [];

	afterEach(() => {
		// Clean up test jobs
		const jobsDir = join(homedir(), ".randal", "jobs");
		for (const id of testIds) {
			const path = join(jobsDir, `${id}.yaml`);
			if (existsSync(path)) {
				rmSync(path);
			}
		}
		testIds.length = 0;
	});

	test("save and load job", () => {
		const job = makeJob("test-save-001");
		testIds.push(job.id);

		saveJob(job);
		const loaded = loadJob(job.id);

		expect(loaded).not.toBeNull();
		expect(loaded?.id).toBe(job.id);
		expect(loaded?.status).toBe("running");
		expect(loaded?.prompt).toBe("test prompt");
	});

	test("loadJob returns null for missing", () => {
		expect(loadJob("nonexistent-id")).toBeNull();
	});

	test("listJobs returns saved jobs", () => {
		const job1 = makeJob("test-list-001", "running");
		const job2 = makeJob("test-list-002", "complete");
		testIds.push(job1.id, job2.id);

		saveJob(job1);
		saveJob(job2);

		const all = listJobs();
		expect(all.some((j) => j.id === job1.id)).toBe(true);
		expect(all.some((j) => j.id === job2.id)).toBe(true);
	});

	test("listJobs filters by status", () => {
		const job1 = makeJob("test-filter-001", "running");
		const job2 = makeJob("test-filter-002", "complete");
		testIds.push(job1.id, job2.id);

		saveJob(job1);
		saveJob(job2);

		const running = listJobs("running");
		expect(running.some((j) => j.id === job1.id)).toBe(true);
		expect(running.some((j) => j.id === job2.id)).toBe(false);
	});

	test("updateJob modifies job", () => {
		const job = makeJob("test-update-001");
		testIds.push(job.id);

		saveJob(job);
		const updated = updateJob(job.id, { status: "complete" });

		expect(updated).not.toBeNull();
		expect(updated?.status).toBe("complete");

		const loaded = loadJob(job.id);
		expect(loaded?.status).toBe("complete");
	});
});
