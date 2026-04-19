import { describe, expect, mock, test } from "bun:test";
import { parseVoiceSessionAccess } from "@randal/core";
import type { ChannelDeps } from "./channel.js";
import { VoiceChannel } from "./voice.js";

// ── Helpers ─────────────────────────────────────────────────

function makeMockDeps(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
	return {
		config: { name: "test" } as ChannelDeps["config"],
		runner: {
			submit: mock(() => ({ jobId: "job-1", done: Promise.resolve() })),
			getJob: mock(() => null),
			getActiveJobs: mock(() => []),
			stop: mock(() => true),
		} as unknown as ChannelDeps["runner"],
		eventBus: {
			subscribe: mock(() => () => {}),
			emit: mock(() => {}),
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
		access: {
			trustedCallers: [] as string[],
			unknownInbound: "deny" as const,
			defaultExternalGrants: [] as string[],
		},
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────

describe("VoiceChannel", () => {
	test("adapter name is 'voice'", () => {
		const config = makeVoiceConfig({ allowFrom: ["+15551234567"] });
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
		const config = makeVoiceConfig({ allowFrom: ["+15551234567"] });
		const channel = new VoiceChannel(config as never, deps);

		await channel.start();
		expect(subscribe).toHaveBeenCalledTimes(1);

		channel.stop();
		// After stop, sessions should be cleared
		expect(channel.getActiveSessions()).toHaveLength(0);
	});

	test("registerSession and handleSttInput routes to handleCommand", async () => {
		const submitMock = mock(() => ({ jobId: "job-voice-1", done: Promise.resolve() }));
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
		});
		const config = makeVoiceConfig({ allowFrom: ["+15551234567"] });
		const channel = new VoiceChannel(config as never, deps);

		const ttsCallback = mock(() => {});

		// Register a session
		channel.registerSession("session-1", "+15551234567", ttsCallback);
		expect(channel.hasSession("session-1")).toBe(true);
		expect(channel.getActiveSessions()).toHaveLength(1);

		// Send STT input
		await channel.handleSttInput("session-1", "run: build the dashboard");

		// Should have called handleCommand which calls runner.submit
		expect(submitMock).toHaveBeenCalledTimes(1);
		const submitArg = (submitMock.mock.calls as unknown[][])[0][0] as {
			metadata?: Record<string, string>;
		};
		const access = parseVoiceSessionAccess(submitArg.metadata?.RANDAL_VOICE_ACCESS);
		expect(access?.accessClass).toBe("admin");
		expect(access?.source.trustedCaller).toBe(true);
		// TTS callback should have been called with response
		expect(ttsCallback).toHaveBeenCalledTimes(1);
		const ttsText = (ttsCallback.mock.calls as unknown[][])[0][0] as string;
		expect(ttsText).toContain("job-voice-1");

		// Unregister
		channel.unregisterSession("session-1");
		expect(channel.hasSession("session-1")).toBe(false);
	});

	test("handleSttInput ignores unknown sessions", async () => {
		const deps = makeMockDeps();
		const config = makeVoiceConfig();
		const channel = new VoiceChannel(config as never, deps);

		// No session registered — should silently return
		await channel.handleSttInput("nonexistent", "hello");
		expect(deps.runner.submit).not.toHaveBeenCalled();
	});

	test("unknown inbound callers are denied by default", () => {
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

		// Trusted phone number
		const ttsCallback2 = mock(() => {});
		channel.registerSession("session-ok", "+15551111111", ttsCallback2);
		expect(channel.hasSession("session-ok")).toBe(true);
		// Should NOT have called the rejection callback
		expect(ttsCallback2).not.toHaveBeenCalled();
	});

	test("unknown inbound callers can resolve to external access when configured", async () => {
		const submitMock = mock(() => ({ jobId: "job-voice-2", done: Promise.resolve() }));
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
		});
		const config = makeVoiceConfig({
			access: { unknownInbound: "external", defaultExternalGrants: ["memory"] },
		});
		const channel = new VoiceChannel(config as never, deps);
		const ttsCallback = mock(() => {});

		channel.registerSession("session-ext", "+15559999999", ttsCallback);
		await channel.handleSttInput("session-ext", "run: summarize the issue");

		const submitArg = (submitMock.mock.calls as unknown[][])[0][0] as {
			metadata?: Record<string, string>;
		};
		const access = parseVoiceSessionAccess(submitArg.metadata?.RANDAL_VOICE_ACCESS);
		expect(access?.accessClass).toBe("external");
		expect(access?.capabilities.grants).toEqual(["memory"]);
		expect(access?.source.trustedCaller).toBe(false);
	});

	test("outbound sessions can attach explicit external grants", async () => {
		const submitMock = mock(() => ({ jobId: "job-voice-3", done: Promise.resolve() }));
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
		});
		const channel = new VoiceChannel(makeVoiceConfig() as never, deps);
		const ttsCallback = mock(() => {});

		channel.registerSessionWithAccess("session-out", "+15553333333", ttsCallback, {
			direction: "outbound",
			requestedAccess: { accessClass: "external", grants: ["scheduler", "events"] },
		});
		await channel.handleSttInput("session-out", "run: follow up with the customer");

		const submitArg = (submitMock.mock.calls as unknown[][])[0][0] as {
			metadata?: Record<string, string>;
		};
		const access = parseVoiceSessionAccess(submitArg.metadata?.RANDAL_VOICE_ACCESS);
		expect(access?.accessClass).toBe("external");
		expect(access?.source.direction).toBe("outbound");
		expect(access?.capabilities.grants).toEqual(["events", "scheduler"]);
	});

	test("outbound sessions default to external access when no request is provided", async () => {
		const submitMock = mock(() => ({ jobId: "job-voice-4", done: Promise.resolve() }));
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
		});
		const channel = new VoiceChannel(
			makeVoiceConfig({ access: { defaultExternalGrants: ["memory"] } }) as never,
			deps,
		);
		const ttsCallback = mock(() => {});

		channel.registerSessionWithAccess("session-out-default", "+15554444444", ttsCallback, {
			direction: "outbound",
		});
		await channel.handleSttInput("session-out-default", "run: check status");

		const submitArg = (submitMock.mock.calls as unknown[][])[0][0] as {
			metadata?: Record<string, string>;
		};
		const access = parseVoiceSessionAccess(submitArg.metadata?.RANDAL_VOICE_ACCESS);
		expect(access?.accessClass).toBe("external");
		expect(access?.capabilities.grants).toEqual(["memory"]);
	});
});
