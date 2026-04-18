import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Job, MeshInstance, RunnerEvent } from "@randal/core";
import type { RoutingDecision } from "@randal/mesh";
import { DelegatedJobTracker, createDelegatedJob } from "../delegation.js";
import { EventBus } from "../events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMeshInstance(overrides?: Partial<MeshInstance>): MeshInstance {
	return {
		instanceId: "inst-1",
		name: "agent-alpha",
		capabilities: ["coding"],
		status: "idle",
		lastHeartbeat: new Date().toISOString(),
		endpoint: "http://alpha:7600",
		models: ["claude-sonnet-4-20250514"],
		activeJobs: 0,
		completedJobs: 10,
		health: { uptime: 3600, missedPings: 0 },
		...overrides,
	};
}

function makeRoutingDecision(overrides?: Partial<RoutingDecision>): RoutingDecision {
	return {
		instance: makeMeshInstance(),
		score: 0.85,
		breakdown: {
			expertiseScore: 0.9,
			reliabilityScore: 0.8,
			loadScore: 1.0,
			modelMatchScore: 0.6,
		},
		reason: "Best match for coding task",
		...overrides,
	};
}

/**
 * Collect all events emitted on the bus.
 */
function collectEvents(bus: EventBus): RunnerEvent[] {
	const events: RunnerEvent[] = [];
	bus.subscribe((e) => events.push(e));
	return events;
}

/**
 * Build a mock fetch that returns canned responses in sequence.
 * Each entry is either a response object or an Error to throw.
 */
function mockFetchSequence(
	responses: Array<{ status: number; body: unknown } | Error>,
): typeof globalThis.fetch {
	let callIndex = 0;
	return mock((_url: string | URL | Request, _init?: RequestInit) => {
		const entry = responses[callIndex++] ?? responses[responses.length - 1];
		if (entry instanceof Error) {
			return Promise.reject(entry);
		}
		return Promise.resolve(
			new Response(JSON.stringify(entry.body), {
				status: entry.status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	}) as unknown as typeof globalThis.fetch;
}

/**
 * Wait for a condition with timeout.
 */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
	intervalMs = 50,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DelegatedJobTracker", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("polls at the configured interval", async () => {
		const bus = new EventBus();
		const callTimes: number[] = [];

		globalThis.fetch = mock(async () => {
			callTimes.push(Date.now());
			return new Response(JSON.stringify({ status: "running" }), { status: 200 });
		}) as unknown as typeof globalThis.fetch;

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 100,
		});
		tracker.start();

		// Wait for at least 3 polls
		await waitFor(() => callTimes.length >= 3, 3000);
		tracker.stop();

		// Check intervals are approximately 100ms (allow some tolerance)
		for (let i = 1; i < callTimes.length; i++) {
			const delta = callTimes[i] - callTimes[i - 1];
			expect(delta).toBeGreaterThanOrEqual(80);
			expect(delta).toBeLessThan(300);
		}
	});

	test("emits job.started on first poll showing running", async () => {
		const bus = new EventBus();
		const events = collectEvents(bus);

		globalThis.fetch = mockFetchSequence([
			{ status: 200, body: { status: "running" } },
			{ status: 200, body: { status: "running" } },
		]);

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
		});
		tracker.start();

		await waitFor(() => events.some((e) => e.type === "job.started"), 3000);
		tracker.stop();

		const startedEvents = events.filter((e) => e.type === "job.started");
		expect(startedEvents).toHaveLength(1);
		expect(startedEvents[0].jobId).toBe("local-1");
	});

	test("emits iteration.output when remote has progress", async () => {
		const bus = new EventBus();
		const events = collectEvents(bus);

		globalThis.fetch = mockFetchSequence([
			{
				status: 200,
				body: {
					status: "running",
					progressHistory: ["Working on step 1..."],
					iterations: { current: 1 },
				},
			},
		]);

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
		});
		tracker.start();

		await waitFor(() => events.some((e) => e.type === "iteration.output"), 3000);
		tracker.stop();

		const outputEvents = events.filter((e) => e.type === "iteration.output");
		expect(outputEvents.length).toBeGreaterThanOrEqual(1);
		expect(outputEvents[0].data.output).toBe("Working on step 1...");
		expect(outputEvents[0].data.iteration).toBe(1);
	});

	test("emits job.complete when remote completes", async () => {
		const bus = new EventBus();
		const events = collectEvents(bus);

		globalThis.fetch = mockFetchSequence([
			{ status: 200, body: { status: "running" } },
			{
				status: 200,
				body: {
					status: "complete",
					summary: "All done",
					filesChanged: ["src/index.ts"],
				},
			},
		]);

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
		});
		tracker.start();

		await waitFor(() => events.some((e) => e.type === "job.complete"), 3000);

		const completeEvent = events.find((e) => e.type === "job.complete");
		expect(completeEvent).toBeDefined();
		expect(completeEvent!.jobId).toBe("local-1");
		expect(completeEvent!.data.summary).toBe("All done");
		expect(completeEvent!.data.filesChanged).toEqual(["src/index.ts"]);

		// Should have auto-stopped
		const state = tracker.getState();
		expect(state.status).toBe("complete");
	});

	test("emits job.failed when remote fails", async () => {
		const bus = new EventBus();
		const events = collectEvents(bus);

		globalThis.fetch = mockFetchSequence([
			{
				status: 200,
				body: { status: "failed", error: "Compilation error" },
			},
		]);

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
		});
		tracker.start();

		await waitFor(() => events.some((e) => e.type === "job.failed"), 3000);

		const failEvent = events.find((e) => e.type === "job.failed");
		expect(failEvent).toBeDefined();
		expect(failEvent!.data.error).toBe("Compilation error");

		const state = tracker.getState();
		expect(state.status).toBe("failed");
	});

	test("handles network errors with exponential backoff", async () => {
		const bus = new EventBus();
		const callTimes: number[] = [];

		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			callTimes.push(Date.now());
			if (callCount <= 3) {
				throw new Error("Connection refused");
			}
			return new Response(JSON.stringify({ status: "running" }), { status: 200 });
		}) as unknown as typeof globalThis.fetch;

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
			maxPollIntervalMs: 400,
		});
		tracker.start();

		// Wait for the recovery poll (4th call)
		await waitFor(() => callCount >= 4, 5000);
		tracker.stop();

		// After failures, interval should have increased (exponential backoff)
		// 1st: 50ms, 2nd: 100ms (50*2), 3rd: 200ms (100*2)
		if (callTimes.length >= 3) {
			const gap2 = callTimes[2] - callTimes[1];
			const gap1 = callTimes[1] - callTimes[0];
			// Second gap should be larger due to backoff
			expect(gap2).toBeGreaterThanOrEqual(gap1);
		}

		// After recovery, consecutive failures should be reset
		const state = tracker.getState();
		expect(state.consecutiveFailures).toBe(0);
	});

	test("emits job.failed after max consecutive failures", async () => {
		const bus = new EventBus();
		const events = collectEvents(bus);

		globalThis.fetch = mockFetchSequence([
			new Error("Connection refused"),
			new Error("Connection refused"),
			new Error("Connection refused"),
		]);

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 30,
			maxPollIntervalMs: 60,
			maxConsecutiveFailures: 3,
		});
		tracker.start();

		await waitFor(() => events.some((e) => e.type === "job.failed"), 5000);

		const failEvent = events.find((e) => e.type === "job.failed");
		expect(failEvent).toBeDefined();
		expect(failEvent!.data.error).toContain("3 consecutive attempts");

		const state = tracker.getState();
		expect(state.status).toBe("failed");
	});

	test("stops cleanly on stop()", async () => {
		const bus = new EventBus();
		let pollCount = 0;

		globalThis.fetch = mock(async () => {
			pollCount++;
			return new Response(JSON.stringify({ status: "running" }), { status: 200 });
		}) as unknown as typeof globalThis.fetch;

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
		});
		tracker.start();

		await waitFor(() => pollCount >= 2, 3000);
		tracker.stop();

		const countAfterStop = pollCount;
		// Wait a bit and verify no more polls happen
		await new Promise((r) => setTimeout(r, 200));
		expect(pollCount).toBe(countAfterStop);
	});

	test("stop() is safe to call multiple times", () => {
		const bus = new EventBus();
		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus);
		tracker.stop();
		tracker.stop(); // Should not throw
	});

	test("start() after stop() is a no-op", async () => {
		const bus = new EventBus();
		let pollCount = 0;

		globalThis.fetch = mock(async () => {
			pollCount++;
			return new Response(JSON.stringify({ status: "running" }), { status: 200 });
		}) as unknown as typeof globalThis.fetch;

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
		});
		tracker.stop();
		tracker.start();

		await new Promise((r) => setTimeout(r, 200));
		expect(pollCount).toBe(0);
	});

	test("getState() returns correct tracking state", () => {
		const bus = new EventBus();
		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus);

		const state = tracker.getState();
		expect(state.remoteJobId).toBe("remote-1");
		expect(state.remoteEndpoint).toBe("http://remote:7600");
		expect(state.status).toBe("running");
		expect(state.lastPolled).toBeNull();
		expect(state.lastRemoteStatus).toBeNull();
		expect(state.consecutiveFailures).toBe(0);
	});

	test("sends auth token as Bearer header", async () => {
		const bus = new EventBus();
		let capturedHeaders: Record<string, string> = {};

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = Object.fromEntries(
				Object.entries(init?.headers ?? {}),
			);
			return new Response(JSON.stringify({ status: "complete", summary: "done" }), {
				status: 200,
			});
		}) as unknown as typeof globalThis.fetch;

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
			authToken: "secret-token-123",
		});
		tracker.start();

		await waitFor(() => Object.keys(capturedHeaders).length > 0, 3000);
		tracker.stop();

		expect(capturedHeaders.Authorization).toBe("Bearer secret-token-123");
	});

	test("polls correct URL", async () => {
		const bus = new EventBus();
		let capturedUrl = "";

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			capturedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			return new Response(JSON.stringify({ status: "complete", summary: "ok" }), {
				status: 200,
			});
		}) as unknown as typeof globalThis.fetch;

		const tracker = new DelegatedJobTracker(
			"local-1",
			"http://remote:7600",
			"remote-job-42",
			bus,
			{ pollIntervalMs: 50 },
		);
		tracker.start();

		await waitFor(() => capturedUrl.length > 0, 3000);
		tracker.stop();

		expect(capturedUrl).toBe("http://remote:7600/job/remote-job-42");
	});

	test("handles HTTP error responses with backoff", async () => {
		const bus = new EventBus();
		let pollCount = 0;

		globalThis.fetch = mock(async () => {
			pollCount++;
			if (pollCount <= 2) {
				return new Response("Internal Server Error", { status: 500 });
			}
			return new Response(JSON.stringify({ status: "running" }), { status: 200 });
		}) as unknown as typeof globalThis.fetch;

		const tracker = new DelegatedJobTracker("local-1", "http://remote:7600", "remote-1", bus, {
			pollIntervalMs: 50,
			maxPollIntervalMs: 400,
		});
		tracker.start();

		await waitFor(() => pollCount >= 3, 5000);
		tracker.stop();

		// After recovery, failures should be reset
		const state = tracker.getState();
		expect(state.consecutiveFailures).toBe(0);
	});
});

describe("DelegatedJobTracker.recover()", () => {
	test("recreates tracker from job metadata", () => {
		const bus = new EventBus();
		const job: Job = {
			id: "del-abc-123",
			status: "running",
			prompt: "Fix the bug",
			agent: "delegated",
			model: "claude-sonnet-4-20250514",
			maxIterations: 0,
			workdir: "",
			createdAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
			completedAt: null,
			duration: null,
			iterations: { current: 0, history: [] },
			plan: [],
			progressHistory: [],
			delegations: [],
			cost: { totalTokens: { input: 0, output: 0 }, estimatedCost: 0, wallTime: 0 },
			updates: [],
			error: null,
			exitCode: null,
			metadata: {
				"delegation.remoteAgent": "agent-alpha",
				"delegation.remoteEndpoint": "http://alpha:7600",
				"delegation.remoteJobId": "remote-42",
				"delegation.startedAt": new Date().toISOString(),
				"delegation.status": "running",
			},
		};

		const tracker = DelegatedJobTracker.recover(job, bus);
		expect(tracker).not.toBeNull();

		const state = tracker!.getState();
		expect(state.remoteJobId).toBe("remote-42");
		expect(state.remoteEndpoint).toBe("http://alpha:7600");
		expect(state.status).toBe("running");
	});

	test("returns null for job without delegation metadata", () => {
		const bus = new EventBus();
		const job: Job = {
			id: "regular-job",
			status: "running",
			prompt: "Build something",
			agent: "opencode",
			model: "claude-sonnet-4-20250514",
			maxIterations: 10,
			workdir: "/tmp",
			createdAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
			completedAt: null,
			duration: null,
			iterations: { current: 0, history: [] },
			plan: [],
			progressHistory: [],
			delegations: [],
			cost: { totalTokens: { input: 0, output: 0 }, estimatedCost: 0, wallTime: 0 },
			updates: [],
			error: null,
			exitCode: null,
		};

		const tracker = DelegatedJobTracker.recover(job, bus);
		expect(tracker).toBeNull();
	});

	test("returns null for job with incomplete delegation metadata", () => {
		const bus = new EventBus();
		const job: Job = {
			id: "partial-del",
			status: "running",
			prompt: "Test",
			agent: "delegated",
			model: "unknown",
			maxIterations: 0,
			workdir: "",
			createdAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
			completedAt: null,
			duration: null,
			iterations: { current: 0, history: [] },
			plan: [],
			progressHistory: [],
			delegations: [],
			cost: { totalTokens: { input: 0, output: 0 }, estimatedCost: 0, wallTime: 0 },
			updates: [],
			error: null,
			exitCode: null,
			metadata: {
				"delegation.remoteAgent": "alpha",
				// Missing remoteEndpoint and remoteJobId
			},
		};

		const tracker = DelegatedJobTracker.recover(job, bus);
		expect(tracker).toBeNull();
	});
});

describe("createDelegatedJob()", () => {
	test("produces correct Job shape with delegation metadata", () => {
		const decision = makeRoutingDecision();
		const job = createDelegatedJob(
			{
				prompt: "Fix the authentication bug",
				origin: { channel: "discord", replyTo: "thread-123", from: "user-456" },
				model: "claude-sonnet-4-20250514",
			},
			decision,
			"remote-job-99",
		);

		// ID format
		expect(job.id).toMatch(/^del-[a-f0-9]+-\d+$/);

		// Core fields
		expect(job.status).toBe("running");
		expect(job.prompt).toBe("Fix the authentication bug");
		expect(job.model).toBe("claude-sonnet-4-20250514");
		expect(job.agent).toBe("delegated");
		expect(job.workdir).toBe("");
		expect(job.maxIterations).toBe(0);

		// Timestamps
		expect(job.createdAt).toBeTruthy();
		expect(job.startedAt).toBeTruthy();
		expect(job.completedAt).toBeNull();
		expect(job.duration).toBeNull();

		// Origin preserved
		expect(job.origin).toEqual({
			channel: "discord",
			replyTo: "thread-123",
			from: "user-456",
		});

		// Delegation metadata
		expect(job.metadata).toBeDefined();
		expect(job.metadata!["delegation.remoteAgent"]).toBe("agent-alpha");
		expect(job.metadata!["delegation.remoteEndpoint"]).toBe("http://alpha:7600");
		expect(job.metadata!["delegation.remoteJobId"]).toBe("remote-job-99");
		expect(job.metadata!["delegation.status"]).toBe("running");
		expect(job.metadata!["delegation.routingScore"]).toBe("0.850");
		expect(job.metadata!["delegation.routingReason"]).toBe("Best match for coding task");

		// Delegations array
		expect(job.delegations).toHaveLength(1);
		expect(job.delegations[0].jobId).toBe("remote-job-99");
		expect(job.delegations[0].status).toBe("running");

		// Updates
		expect(job.updates).toHaveLength(1);
		expect(job.updates[0]).toContain("agent-alpha");
		expect(job.updates[0]).toContain("0.85");

		// Cost initialized
		expect(job.cost.estimatedCost).toBe(0);
		expect(job.cost.totalTokens.input).toBe(0);
	});

	test("uses default model from routing decision when not specified", () => {
		const decision = makeRoutingDecision({
			instance: makeMeshInstance({ models: ["gpt-4o"] }),
		});
		const job = createDelegatedJob({ prompt: "Test task" }, decision, "remote-1");

		expect(job.model).toBe("gpt-4o");
		expect(job.agent).toBe("delegated");
	});

	test("preserves custom metadata", () => {
		const decision = makeRoutingDecision();
		const job = createDelegatedJob(
			{
				prompt: "Test",
				metadata: { "custom.key": "custom-value" },
			},
			decision,
			"remote-1",
		);

		expect(job.metadata!["custom.key"]).toBe("custom-value");
		expect(job.metadata!["delegation.remoteAgent"]).toBe("agent-alpha");
	});
});
