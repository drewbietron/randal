import { describe, expect, mock, test } from "bun:test";
import type { RunnerEvent } from "@randal/core";
import type { ChannelDeps } from "./channel.js";
import { VoiceChannel } from "./voice.js";

// ── Helpers ─────────────────────────────────────────────────

function makeMockDeps(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
	const subscribers = new Set<(event: RunnerEvent) => void>();
	return {
		config: { name: "test", runner: { workdir: "/tmp/voice-test" } } as ChannelDeps["config"],
		runner: {
			submit: mock(() => ({ jobId: "job-1", done: Promise.resolve() })),
			getJob: mock(() => null),
			getActiveJobs: mock(() => []),
			stop: mock(() => true),
		} as unknown as ChannelDeps["runner"],
		eventBus: {
			subscribe: mock((handler: (event: RunnerEvent) => void) => {
				subscribers.add(handler);
				return () => subscribers.delete(handler);
			}),
			emit: mock((event: RunnerEvent) => {
				for (const handler of subscribers) {
					handler(event);
				}
			}),
			subscriberCount: 0,
		} as unknown as ChannelDeps["eventBus"],
		...overrides,
	};
}

function makeVoiceConfig(overrides: Record<string, unknown> = {}) {
	return {
		type: "voice" as const,
		provider: "twilio",
		allowFrom: [] as string[],
		...overrides,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

// ── Tests ───────────────────────────────────────────────────

describe("VoiceChannel", () => {
	test("adapter name is 'voice'", () => {
		const config = makeVoiceConfig();
		const deps = makeMockDeps();
		const channel = new VoiceChannel(config as never, deps);
		expect(channel.name).toBe("voice");
	});

	test("start/stop lifecycle", async () => {
		const unsubscribe = mock(() => {});
		const subscribe = mock(() => unsubscribe);
		const deps = makeMockDeps({
			eventBus: {
				subscribe,
				emit: mock(() => {}),
				subscriberCount: 0,
			} as unknown as ChannelDeps["eventBus"],
		});
		const config = makeVoiceConfig();
		const channel = new VoiceChannel(config as never, deps);

		await channel.start();
		expect(subscribe).toHaveBeenCalledTimes(1);

		channel.stop();
		// After stop, sessions should be cleared
		expect(channel.getActiveSessions()).toHaveLength(0);
	});

	test("registerSession and handleSttInput routes through runner bridge", async () => {
		const messageAdds: Array<Record<string, unknown>> = [];
		const memoryIndexes: Array<Record<string, unknown>> = [];
		const submitMock = mock((request: Record<string, unknown>) => {
			queueMicrotask(() => {
				deps.eventBus.emit({
					type: "job.complete",
					jobId: "job-voice-1",
					timestamp: new Date().toISOString(),
					data: { output: "I can help with that." },
				});
			});
			return {
				jobId: "job-voice-1",
				done: Promise.resolve({
					id: "job-voice-1",
					status: "complete",
					prompt: String(request.prompt ?? ""),
					agent: "mock",
					model: "mock",
					maxIterations: 1,
					workdir: "/tmp",
					createdAt: new Date().toISOString(),
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					duration: 1,
					iterations: { current: 1, history: [] },
					plan: [],
					progressHistory: [],
					delegations: [],
					cost: { totalTokens: { input: 0, output: 0 }, estimatedCost: 0, wallTime: 1 },
					updates: [],
					error: null,
					exitCode: 0,
					origin: request.origin as never,
					metadata: request.metadata as never,
				}),
			};
		});
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
			messageManager: {
				add: mock(async (doc: Record<string, unknown>) => {
					messageAdds.push(doc);
					return `msg-${messageAdds.length}`;
				}),
				endSession: mock(async () => {}),
			} as unknown as ChannelDeps["messageManager"],
			memoryManager: {
				index: mock(async (doc: Record<string, unknown>) => {
					memoryIndexes.push(doc);
					return { status: "success", id: "mem-1" };
				}),
			} as unknown as ChannelDeps["memoryManager"],
		});
		const config = makeVoiceConfig();
		const channel = new VoiceChannel(config as never, deps);

		const ttsCallback = mock(() => {});

		// Register a session
		channel.registerSession("session-1", "+15551234567", ttsCallback);
		expect(channel.hasSession("session-1")).toBe(true);
		expect(channel.getActiveSessions()).toHaveLength(1);

		// Send STT input
		await channel.handleSttInput("session-1", "run: build the dashboard");

		// Should submit one runner job using a voice-specific prompt overlay
		expect(submitMock).toHaveBeenCalledTimes(1);
		const request = (submitMock.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
		expect(String(request.prompt)).toContain("Voice response mode is active");
		expect(String(request.prompt)).toContain("Caller transcript:");
		expect(String(request.prompt)).toContain("run: build the dashboard");
		expect(request.metadata).toEqual({
			voiceSessionId: "session-1",
			voiceThreadId: "voice:session-1",
			voiceMode: "spoken-response",
		});

		// TTS callback should receive only the final assistant output
		expect(ttsCallback).toHaveBeenCalledTimes(1);
		const ttsText = (ttsCallback.mock.calls as unknown[][])[0][0] as string;
		expect(ttsText).toBe("I can help with that.");

		// Transcript and assistant turn are written to stable thread history
		expect(messageAdds).toHaveLength(2);
		expect(messageAdds[0].threadId).toBe("voice:session-1");
		expect(messageAdds[0].speaker).toBe("user");
		expect(messageAdds[0].content).toBe("run: build the dashboard");
		expect(messageAdds[1].threadId).toBe("voice:session-1");
		expect(messageAdds[1].speaker).toBe("randal");
		expect(messageAdds[1].jobId).toBe("job-voice-1");

		// Unregister persists session summary artifacts non-fatally
		await channel.unregisterSession("session-1");
		await flushMicrotasks();
		expect(memoryIndexes).toHaveLength(1);
		expect(String(memoryIndexes[0].content)).toContain("session-complete");
		expect(String(memoryIndexes[0].content)).toContain("threadId: voice:session-1");
		expect(String(memoryIndexes[0].content)).toContain("phone: ***4567");
		expect(channel.hasSession("session-1")).toBe(false);
	});

	test("voice persistence failures do not break live response flow", async () => {
		const submitMock = mock(() => {
			queueMicrotask(() => {
				deps.eventBus.emit({
					type: "job.complete",
					jobId: "job-voice-2",
					timestamp: new Date().toISOString(),
					data: { output: "Still working." },
				});
			});
			return {
				jobId: "job-voice-2",
				done: Promise.resolve(),
			};
		});
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
			messageManager: {
				add: mock(async () => {
					throw new Error("message store down");
				}),
				endSession: mock(async () => {
					throw new Error("summary down");
				}),
			} as unknown as ChannelDeps["messageManager"],
			memoryManager: {
				index: mock(async () => {
					throw new Error("memory down");
				}),
			} as unknown as ChannelDeps["memoryManager"],
		});
		const channel = new VoiceChannel(makeVoiceConfig() as never, deps);
		const ttsCallback = mock(() => {});

		channel.registerSession("session-2", "+15551230000", ttsCallback);
		await channel.handleSttInput("session-2", "hello there");

		expect(ttsCallback).toHaveBeenCalledWith("Still working.");
		await channel.unregisterSession("session-2");
		await flushMicrotasks();
	});

	test("serializes overlapping turns within a session", async () => {
		const ttsCallback = mock(() => {});
		const turnResolvers = new Map<string, () => void>();
		const deps = makeMockDeps();
		const submitMock = mock(() => {
			const jobId = `job-${turnResolvers.size + 1}`;
			return {
				jobId,
				done: new Promise<void>((resolve) => {
					turnResolvers.set(jobId, () => {
						deps.eventBus.emit({
							type: "job.complete",
							jobId,
							timestamp: new Date().toISOString(),
							data: { output: `response-${jobId}` },
						});
						resolve();
					});
				}),
			};
		});
		const channel = new VoiceChannel(makeVoiceConfig() as never, {
			...deps,
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
		});

		channel.registerSession("session-serial", "+15550000001", ttsCallback);

		const firstTurn = channel.handleSttInput("session-serial", "first request");
		const secondTurn = channel.handleSttInput("session-serial", "second request");

		await flushMicrotasks();
		expect(submitMock).toHaveBeenCalledTimes(1);
		turnResolvers.get("job-1")?.();
		await firstTurn;
		await flushMicrotasks();
		expect(submitMock).toHaveBeenCalledTimes(2);
		turnResolvers.get("job-2")?.();

		await secondTurn;
		expect((ttsCallback.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
			"response-job-1",
			"response-job-2",
		]);
	});

	test("times out a voice turn if terminal runner events never arrive", async () => {
		const previousTimeout = process.env.RANDAL_VOICE_TURN_TIMEOUT_MS;
		process.env.RANDAL_VOICE_TURN_TIMEOUT_MS = "10";

		try {
			const stopMock = mock(() => true);
			const ttsCallback = mock(() => {});
			const channel = new VoiceChannel(makeVoiceConfig() as never, {
				...makeMockDeps(),
				runner: {
					submit: mock(() => ({ jobId: "job-timeout", done: new Promise(() => {}) })),
					getJob: mock(() => null),
					getActiveJobs: mock(() => []),
					stop: stopMock,
				} as unknown as ChannelDeps["runner"],
			});

			channel.registerSession("session-timeout", "+15550000002", ttsCallback);
			await channel.handleSttInput("session-timeout", "this may hang");

			expect(stopMock).toHaveBeenCalledWith("job-timeout");
			expect(ttsCallback).toHaveBeenCalledWith("Something went wrong processing your request.");
		} finally {
			if (previousTimeout === undefined) {
				process.env.RANDAL_VOICE_TURN_TIMEOUT_MS = undefined;
			} else {
				process.env.RANDAL_VOICE_TURN_TIMEOUT_MS = previousTimeout;
			}
		}
	});

	test("handleSttInput ignores unknown sessions", async () => {
		const deps = makeMockDeps();
		const config = makeVoiceConfig();
		const channel = new VoiceChannel(config as never, deps);

		// No session registered — should silently return
		await channel.handleSttInput("nonexistent", "hello");
		expect(deps.runner.submit).not.toHaveBeenCalled();
	});

	test("allowFrom filter on session registration", () => {
		const deps = makeMockDeps();
		const config = makeVoiceConfig({ allowFrom: ["+15551111111"] });
		const channel = new VoiceChannel(config as never, deps);

		const ttsCallback = mock(() => {});

		// Unauthorized phone number
		channel.registerSession("session-blocked", "+15559999999", ttsCallback);

		// Should have been rejected — session not stored
		expect(channel.hasSession("session-blocked")).toBe(false);
		// Should have called ttsCallback with rejection message
		expect(ttsCallback).toHaveBeenCalledTimes(1);
		const rejectionMsg = (ttsCallback.mock.calls as unknown[][])[0][0] as string;
		expect(rejectionMsg).toContain("not authorized");

		// Authorized phone number
		const ttsCallback2 = mock(() => {});
		channel.registerSession("session-ok", "+15551111111", ttsCallback2);
		expect(channel.hasSession("session-ok")).toBe(true);
		// Should NOT have called the rejection callback
		expect(ttsCallback2).not.toHaveBeenCalled();
	});
});
