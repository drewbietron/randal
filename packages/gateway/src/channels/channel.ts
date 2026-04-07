import type { JobOrigin, RandalConfig, RunnerEvent } from "@randal/core";
import type { MemoryManager, MessageManager, SkillManager } from "@randal/memory";
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
	/** Recover a job→channel mapping after gateway restart. Optional per adapter. */
	recoverJob?(jobId: string, channelId: string): Promise<void>;
	/** Send a message to a specific target (channel ID, thread ID, etc.) */
	send?(target: string, message: string): Promise<void>;
}

export interface ChannelDeps {
	config: RandalConfig;
	runner: Runner;
	eventBus: EventBus;
	memoryManager?: MemoryManager;
	messageManager?: MessageManager;
	scheduler?: Scheduler;
	skillManager?: SkillManager;
	onUpdate?: () => Promise<string>;
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
			const { jobId, done } = deps.runner.submit({
				prompt: args,
				origin,
			});
			// Let job finish in background
			done.catch(() => {});
			return `Job \`${jobId}\` started`;
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

			// Build resume prompt with prior context
			const priorIterations = oldJob.iterations.history
				.map((h: { summary: string; number: number }) => `Iteration ${h.number}: ${h.summary}`)
				.join("\n");

			let resumePrompt = `${oldJob.prompt}\n\n## Prior Run Context\nThis is a resumed job. Previous run reached iteration ${oldJob.iterations.current}.`;
			if (priorIterations) {
				resumePrompt += `\n${priorIterations}`;
			}

			// Include plan state if present
			if (oldJob.plan && oldJob.plan.length > 0) {
				const planLines = oldJob.plan
					.map((t: { task: string; status: string }) => {
						const icon =
							t.status === "completed"
								? "[x]"
								: t.status === "in_progress"
									? "[>]"
									: t.status === "failed"
										? "[!]"
										: "[ ]";
						return `- ${icon} ${t.task} (${t.status})`;
					})
					.join("\n");
				resumePrompt += `\n\n## Task Plan (from previous run)\n${planLines}`;
			}

			// Include progress history if present
			if (oldJob.progressHistory && oldJob.progressHistory.length > 0) {
				resumePrompt += `\n\n## Previous Progress\n${oldJob.progressHistory.join("\n\n")}`;
			}

			const { jobId: resumeJobId, done: resumeDone } = deps.runner.submit({
				prompt: resumePrompt,
				workdir: oldJob.workdir,
				agent: oldJob.agent,
				model: oldJob.model,
				origin,
			});
			resumeDone.catch(() => {});
			return `Resuming job \`${args}\` as \`${resumeJobId}\`...`;
		}

		case "update": {
			if (!deps.onUpdate) return "Update not available in this context.";
			try {
				return await deps.onUpdate();
			} catch (err) {
				return `Update failed: ${err instanceof Error ? err.message : String(err)}`;
			}
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
			// Use full output if available, fall back to summary
			const response = event.data.output || event.data.summary;

			// Single-iteration completion = conversational response, show it directly
			if (response && event.data.iteration === 1) {
				return response;
			}
			const iterPart = event.data.iteration ? ` (${event.data.iteration} iterations)` : "";
			const durPart = event.data.duration ? ` in ${event.data.duration}s` : "";
			const responsePart = response ? `\n${response}` : "";
			return `Job \`${event.jobId}\` complete${iterPart}${durPart}${responsePart}`;
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
		case "iteration.output": {
			const text = event.data.outputLine ?? event.data.summary ?? "";
			return `Progress: ${text}`;
		}
		case "job.plan_updated": {
			const completed = event.data.plan?.filter((t) => t.status === "completed").length ?? 0;
			const total = event.data.plan?.length ?? 0;
			return `Job \`${event.jobId}\` plan: ${completed}/${total} tasks complete`;
		}
		case "job.delegation.started":
			return `Job \`${event.jobId}\` delegating: ${event.data.delegationTask ?? "unknown task"}`;
		case "job.delegation.completed":
			return `Job \`${event.jobId}\` delegation done: ${event.data.delegationTask ?? "unknown task"} (${event.data.delegationStatus ?? "unknown"})`;
		case "system.update":
			return event.data.message ?? "System update in progress...";
		default:
			return `Event: ${event.type} (job ${event.jobId})`;
	}
}
