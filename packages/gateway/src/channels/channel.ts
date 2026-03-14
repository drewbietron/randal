import type { JobOrigin, RandalConfig, RunnerEvent } from "@randal/core";
import type { MemoryManager, SkillManager } from "@randal/memory";
import { type Runner, writeContext } from "@randal/runner";
import type { Scheduler } from "@randal/scheduler";
import type { EventBus } from "../events.js";
import { listJobs, loadJob } from "../jobs.js";
import { formatHelp, parseCommand } from "../router.js";

// ── Interfaces ──────────────────────────────────────────────

export interface ChannelAdapter {
	readonly name: string;
	start(): Promise<void>;
	stop(): void;
}

export interface ChannelDeps {
	config: RandalConfig;
	runner: Runner;
	eventBus: EventBus;
	memoryManager?: MemoryManager;
	scheduler?: Scheduler;
	skillManager?: SkillManager;
}

// ── Shared command handler ──────────────────────────────────

/**
 * Execute a parsed command against the runner/memory/jobs.
 * Shared by all channel adapters (Discord, iMessage, HTTP chat).
 */
export async function handleCommand(
	text: string,
	deps: ChannelDeps,
	origin: JobOrigin,
): Promise<string> {
	const parsed = parseCommand(text);

	// If no recognized command, treat as implicit "run:"
	const command = parsed?.command ?? "run";
	const args = parsed?.args ?? text.trim();

	switch (command) {
		case "run": {
			if (!args) return "Usage: run: <prompt>";
			const jobPromise = deps.runner.execute({
				prompt: args,
				origin,
			});
			// Wait briefly to get the job ID
			await new Promise((r) => setTimeout(r, 50));
			const active = deps.runner.getActiveJobs();
			const latestJob = active[active.length - 1];
			if (latestJob) {
				// Let job finish in background
				jobPromise.catch(() => {});
				return `Job \`${latestJob.id}\` started`;
			}
			// Job may have already completed quickly
			const result = await jobPromise;
			return `Job \`${result.id}\` ${result.status}`;
		}

		case "status": {
			if (args) {
				// Specific job
				const job = deps.runner.getJob(args) ?? loadJob(args);
				if (!job) return `Job \`${args}\` not found`;
				const iter = job.iterations.current;
				const max = job.maxIterations;
				const iterPart = iter ? ` (iteration ${iter}/${max})` : "";
				const durPart = job.duration ? ` — ${job.duration}s` : "";
				return `Job \`${job.id}\` — ${job.status}${iterPart}${durPart}`;
			}
			// All active jobs
			const active = deps.runner.getActiveJobs();
			if (active.length === 0) return "No active jobs";
			return active
				.map(
					(j) => `\`${j.id}\` ${j.status} — iteration ${j.iterations.current}/${j.maxIterations}`,
				)
				.join("\n");
		}

		case "stop": {
			if (args) {
				const stopped = deps.runner.stop(args);
				return stopped ? `Job \`${args}\` stopped` : `Job \`${args}\` not found or not running`;
			}
			// Stop most recent active job
			const active = deps.runner.getActiveJobs();
			if (active.length === 0) return "No active jobs to stop";
			const latest = active[active.length - 1];
			deps.runner.stop(latest.id);
			return `Job \`${latest.id}\` stopped`;
		}

		case "context": {
			if (!args) return "Usage: context: <text>";
			const active = deps.runner.getActiveJobs();
			if (active.length === 0) return "No active jobs to inject context into";
			const latest = active[active.length - 1];
			writeContext(latest.workdir, args);
			return `Context injected into job \`${latest.id}\``;
		}

		case "jobs": {
			const all = listJobs();
			if (all.length === 0) return "No jobs found";
			const active = deps.runner.getActiveJobs();
			const activeIds = new Set(active.map((j) => j.id));

			// Merge active (latest state) with disk jobs
			const merged = [...active, ...all.filter((j) => !activeIds.has(j.id))];
			return merged
				.slice(0, 20) // Limit output
				.map((j) => `\`${j.id}\` ${j.status} — ${j.prompt.slice(0, 60)}`)
				.join("\n");
		}

		case "memory": {
			if (!args) return "Usage: memory: <query>";
			if (!deps.memoryManager) return "Memory not available";
			try {
				const results = await deps.memoryManager.search(args, 5);
				if (results.length === 0) return "No memory results found";
				return results
					.map(
						(r) =>
							`**${r.category}** (${r.source}): ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`,
					)
					.join("\n\n");
			} catch {
				return "Memory search failed";
			}
		}

		case "resume": {
			if (!args) return "Usage: resume: <job-id>";
			const oldJob = loadJob(args);
			if (!oldJob) return `Job \`${args}\` not found`;
			if (oldJob.status !== "failed" && oldJob.status !== "stopped") {
				return `Job \`${args}\` is ${oldJob.status}, not resumable`;
			}
			// Re-execute with same prompt + origin
			const resumePromise = deps.runner.execute({
				prompt: oldJob.prompt,
				workdir: oldJob.workdir,
				agent: oldJob.agent,
				model: oldJob.model,
				origin,
			});
			await new Promise((r) => setTimeout(r, 50));
			const resumeActive = deps.runner.getActiveJobs();
			const resumeLatest = resumeActive[resumeActive.length - 1];
			if (resumeLatest) {
				resumePromise.catch(() => {});
				return `Resuming job \`${args}\` as \`${resumeLatest.id}\`...`;
			}
			const resumeResult = await resumePromise;
			return `Resumed job \`${args}\` as \`${resumeResult.id}\` — ${resumeResult.status}`;
		}

		case "help":
			return formatHelp();

		default:
			return `Unknown command: ${command}. Type \`help\` for available commands.`;
	}
}

// ── Event formatter ─────────────────────────────────────────

/**
 * Format a RunnerEvent into human-readable chat text.
 */
export function formatEvent(event: RunnerEvent): string {
	switch (event.type) {
		case "job.complete": {
			const iterPart = event.data.iteration ? ` (${event.data.iteration} iterations)` : "";
			const durPart = event.data.duration ? ` in ${event.data.duration}s` : "";
			return `Job \`${event.jobId}\` complete${iterPart}${durPart}`;
		}
		case "job.failed":
			return `Job \`${event.jobId}\` failed: ${event.data.error ?? "unknown error"}`;
		case "job.stuck": {
			const indicators = event.data.struggleIndicators?.length
				? `: ${event.data.struggleIndicators.join(", ")}`
				: "";
			return `Job \`${event.jobId}\` may be stuck${indicators}`;
		}
		case "iteration.end": {
			const summaryPart = event.data.summary ? ` — ${event.data.summary}` : "";
			return `Iteration ${event.data.iteration ?? "?"}/${event.data.maxIterations ?? "?"} complete${summaryPart}`;
		}
		default:
			return `Event: ${event.type} (job ${event.jobId})`;
	}
}
