import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "@randal/core";

export interface BuildState {
	status: "active" | "paused" | "completed" | "errored";
	phase?: string;
	currentStep?: string;
	steps?: Array<{ name: string; status: string }>;
	error?: string;
	startedAt?: string;
	completedAt?: string;
	jobId?: string;
	prompt?: string;
}

export interface LoopState {
	version: 1;
	builds: Record<string, BuildState>;
}

function loopStatePath(workdir: string): string {
	return join(workdir, ".opencode", "loop-state.json");
}

export function readLoopState(workdir: string): LoopState {
	const path = loopStatePath(workdir);
	if (!existsSync(path)) {
		return { version: 1, builds: {} };
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as LoopState;
	} catch {
		return { version: 1, builds: {} };
	}
}

export function writeLoopState(workdir: string, state: LoopState): void {
	const dir = join(workdir, ".opencode");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(loopStatePath(workdir), JSON.stringify(state, null, 2));
}

/**
 * Sync a Job object's state into loop-state.json.
 * Called by the Runner after job state changes so the brain
 * and dashboard can see harness-managed job state.
 */
export function syncJobToLoopState(job: Job): void {
	const state = readLoopState(job.workdir);

	const buildStatus: BuildState["status"] =
		job.status === "running"
			? "active"
			: job.status === "complete"
				? "completed"
				: job.status === "failed"
					? "errored"
					: job.status === "stopped"
						? "paused"
						: "active";

	state.builds[job.id] = {
		status: buildStatus,
		phase: job.status === "running" ? "building" : undefined,
		currentStep:
			job.plan.length > 0
				? job.plan.find((t) => t.status === "in_progress")?.task
				: undefined,
		steps:
			job.plan.length > 0
				? job.plan.map((t) => ({ name: t.task, status: t.status }))
				: undefined,
		error: job.error ?? undefined,
		startedAt: job.startedAt ?? undefined,
		completedAt: job.completedAt ?? undefined,
		jobId: job.id,
		prompt: job.prompt.slice(0, 200),
	};

	writeLoopState(job.workdir, state);
}
