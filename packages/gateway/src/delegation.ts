/**
 * Delegated job tracking for posse-routed jobs.
 *
 * When the gateway delegates a job to a remote agent, a DelegatedJobTracker
 * polls the remote agent's job status and emits local RunnerEvents on the
 * EventBus so that all existing subscribers (SSE, Discord, etc.) see progress
 * transparently.
 */

import { createLogger } from "@randal/core";
import type { Job, JobOrigin, JobStatus, RunnerEvent, RunnerEventType } from "@randal/core";
import type { RoutingDecision } from "@randal/mesh";
import type { EventBus } from "./events.js";
import { updateJob } from "./jobs.js";

const logger = createLogger({ context: { component: "delegation" } });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegationMetadata {
	remoteAgent: string;
	remoteEndpoint: string;
	remoteJobId: string;
	startedAt: string;
	status: JobStatus;
	lastPolled: string | null;
}

export interface DelegatedJobTrackerOptions {
	/** Initial polling interval in ms (default: 3000). */
	pollIntervalMs?: number;
	/** Maximum polling interval after exponential backoff (default: 30000). */
	maxPollIntervalMs?: number;
	/** Consecutive poll failures before emitting job.failed (default: 10). */
	maxConsecutiveFailures?: number;
	/** Auth token sent as Bearer header to the remote agent. */
	authToken?: string;
}

interface TrackerState {
	remoteJobId: string;
	remoteEndpoint: string;
	status: JobStatus;
	lastPolled: string | null;
	lastRemoteStatus: string | null;
	consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// DelegatedJobTracker
// ---------------------------------------------------------------------------

export class DelegatedJobTracker {
	private localJobId: string;
	private remoteEndpoint: string;
	private remoteJobId: string;
	private eventBus: EventBus;
	private authToken?: string;

	private pollIntervalMs: number;
	private maxPollIntervalMs: number;
	private maxConsecutiveFailures: number;

	private currentInterval: number;
	private consecutiveFailures = 0;
	private lastRemoteStatus: string | null = null;
	private lastPolled: string | null = null;
	private status: JobStatus = "running";
	private stopped = false;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		localJobId: string,
		remoteEndpoint: string,
		remoteJobId: string,
		eventBus: EventBus,
		options?: DelegatedJobTrackerOptions,
	) {
		this.localJobId = localJobId;
		this.remoteEndpoint = remoteEndpoint;
		this.remoteJobId = remoteJobId;
		this.eventBus = eventBus;
		this.authToken = options?.authToken;

		this.pollIntervalMs = options?.pollIntervalMs ?? 3000;
		this.maxPollIntervalMs = options?.maxPollIntervalMs ?? 30000;
		this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 10;
		this.currentInterval = this.pollIntervalMs;
	}

	/**
	 * Begin the async polling loop. Non-blocking — schedules the first poll
	 * and returns immediately.
	 */
	start(): void {
		if (this.stopped) return;
		this.schedulePoll();
	}

	/**
	 * Stop the polling loop. Safe to call multiple times.
	 */
	stop(): void {
		this.stopped = true;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	/**
	 * Return the current delegation tracking state.
	 */
	getState(): TrackerState {
		return {
			remoteJobId: this.remoteJobId,
			remoteEndpoint: this.remoteEndpoint,
			status: this.status,
			lastPolled: this.lastPolled,
			lastRemoteStatus: this.lastRemoteStatus,
			consecutiveFailures: this.consecutiveFailures,
		};
	}

	// ---- Static factories ----

	/**
	 * Recover a tracker from a Job's delegation metadata.
	 * Used on gateway restart to resume polling for in-flight delegations.
	 */
	static recover(
		job: Job,
		eventBus: EventBus,
		options?: DelegatedJobTrackerOptions,
	): DelegatedJobTracker | null {
		const delegation = job.metadata;
		if (
			!delegation ||
			!delegation["delegation.remoteEndpoint"] ||
			!delegation["delegation.remoteJobId"]
		) {
			return null;
		}

		const tracker = new DelegatedJobTracker(
			job.id,
			delegation["delegation.remoteEndpoint"],
			delegation["delegation.remoteJobId"],
			eventBus,
			options,
		);

		logger.info("Recovered delegation tracker", {
			localJobId: job.id,
			remoteJobId: delegation["delegation.remoteJobId"],
			remoteEndpoint: delegation["delegation.remoteEndpoint"],
		});

		return tracker;
	}

	// ---- Private ----

	private schedulePoll(): void {
		if (this.stopped) return;

		this.pollTimer = setTimeout(async () => {
			await this.poll();
			// Schedule next poll if not terminal
			if (!this.stopped) {
				this.schedulePoll();
			}
		}, this.currentInterval);

		// Don't block process exit
		if (this.pollTimer && typeof this.pollTimer === "object" && "unref" in this.pollTimer) {
			(this.pollTimer as NodeJS.Timeout).unref();
		}
	}

	private async poll(): Promise<void> {
		const url = `${this.remoteEndpoint}/job/${this.remoteJobId}`;
		const headers: Record<string, string> = {};
		if (this.authToken) {
			headers.Authorization = `Bearer ${this.authToken}`;
		}

		try {
			const resp = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(15_000),
			});

			if (!resp.ok) {
				this.handlePollFailure(`HTTP ${resp.status}`);
				return;
			}

			const data = (await resp.json()) as {
				status?: string;
				summary?: string;
				error?: string;
				filesChanged?: string[];
				progressHistory?: string[];
				iterations?: { current?: number };
			};

			// Reset backoff on successful poll
			this.consecutiveFailures = 0;
			this.currentInterval = this.pollIntervalMs;
			this.lastPolled = new Date().toISOString();

			const remoteStatus = data.status ?? "unknown";
			const previousStatus = this.lastRemoteStatus;
			this.lastRemoteStatus = remoteStatus;

			// Persist poll state to disk
			this.persistState();

			// Map remote status changes to local events
			if (remoteStatus === "running" && previousStatus !== "running") {
				this.emitEvent("job.started", {});
			}

			// Emit progress if there's new output
			if (data.progressHistory && data.progressHistory.length > 0) {
				const latestProgress = data.progressHistory[data.progressHistory.length - 1];
				this.emitEvent("iteration.output", {
					output: latestProgress,
					iteration: data.iterations?.current,
				});
			}

			// Terminal states
			if (remoteStatus === "complete" || remoteStatus === "completed") {
				this.status = "complete";
				this.emitEvent("job.complete", {
					summary: data.summary ?? "Delegated job completed",
					filesChanged: data.filesChanged,
				});
				this.stop();
			} else if (remoteStatus === "failed") {
				this.status = "failed";
				this.emitEvent("job.failed", {
					error: data.error ?? "Delegated job failed on remote agent",
				});
				this.stop();
			} else if (remoteStatus === "stopped") {
				this.status = "stopped";
				this.emitEvent("job.stopped", {});
				this.stop();
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.handlePollFailure(msg);
		}
	}

	private handlePollFailure(reason: string): void {
		this.consecutiveFailures++;
		this.lastPolled = new Date().toISOString();

		// Exponential backoff: double the interval, cap at max
		this.currentInterval = Math.min(this.currentInterval * 2, this.maxPollIntervalMs);

		logger.warn("Delegation poll failed", {
			localJobId: this.localJobId,
			remoteJobId: this.remoteJobId,
			consecutiveFailures: this.consecutiveFailures,
			reason,
			nextIntervalMs: this.currentInterval,
		});

		if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
			this.status = "failed";
			this.emitEvent("job.failed", {
				error: `Delegation polling failed after ${this.consecutiveFailures} consecutive attempts: ${reason}`,
			});
			this.persistState();
			this.stop();
		}
	}

	private emitEvent(type: RunnerEventType, data: RunnerEvent["data"]): void {
		this.eventBus.emit({
			type,
			jobId: this.localJobId,
			timestamp: new Date().toISOString(),
			data,
		});
	}

	private persistState(): void {
		try {
			updateJob(this.localJobId, {
				status: this.status,
				metadata: {
					"delegation.status": this.status,
					"delegation.lastPolled": this.lastPolled ?? "",
					"delegation.lastRemoteStatus": this.lastRemoteStatus ?? "",
				},
			});
		} catch {
			// Best-effort — don't crash the polling loop
		}
	}
}

// ---------------------------------------------------------------------------
// Helper: create a local Job shell for a delegated task
// ---------------------------------------------------------------------------

export interface CreateDelegatedJobRequest {
	prompt: string;
	origin?: JobOrigin;
	model?: string;
	agent?: string;
	metadata?: Record<string, string>;
}

/**
 * Create a local Job object that represents a task delegated to a remote agent.
 * The Job is pre-filled with delegation metadata so it can be persisted and recovered.
 */
export function createDelegatedJob(
	request: CreateDelegatedJobRequest,
	routingDecision: RoutingDecision,
	remoteJobId: string,
): Job {
	const now = new Date().toISOString();
	const id = `del-${crypto.randomUUID().slice(0, 8)}-${Date.now()}`;

	return {
		id,
		status: "running",
		prompt: request.prompt,
		agent: request.agent ?? "delegated",
		model: request.model ?? routingDecision.instance.models[0] ?? "unknown",
		maxIterations: 0,
		workdir: "",
		createdAt: now,
		startedAt: now,
		completedAt: null,
		duration: null,
		iterations: { current: 0, history: [] },
		plan: [],
		progressHistory: [],
		delegations: [
			{
				jobId: remoteJobId,
				task: request.prompt,
				status: "running",
				summary: "",
				filesChanged: [],
				duration: 0,
			},
		],
		cost: {
			totalTokens: { input: 0, output: 0 },
			estimatedCost: 0,
			wallTime: 0,
		},
		updates: [
			`Delegated to ${routingDecision.instance.name} (score: ${routingDecision.score.toFixed(2)})`,
		],
		error: null,
		exitCode: null,
		origin: request.origin,
		metadata: {
			...request.metadata,
			"delegation.remoteAgent": routingDecision.instance.name,
			"delegation.remoteEndpoint": routingDecision.instance.endpoint,
			"delegation.remoteJobId": remoteJobId,
			"delegation.startedAt": now,
			"delegation.status": "running",
			"delegation.routingScore": routingDecision.score.toFixed(3),
			"delegation.routingReason": routingDecision.reason,
		},
	};
}
