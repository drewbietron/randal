import { describe, expect, mock, test } from "bun:test";
import type { ChannelDeps } from "./channel.js";
import { SignalChannel } from "./signal.js";

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

function makeSignalConfig(overrides: Record<string, unknown> = {}) {
	return {
		type: "signal" as const,
		phoneNumber: "+15551234567",
		signalCliBin: "signal-cli",
		allowFrom: [] as string[],
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────

describe("SignalChannel", () => {
	test("adapter name is 'signal'", () => {
		const config = makeSignalConfig();
		const deps = makeMockDeps();
		const channel = new SignalChannel(config as never, deps);
		expect(channel.name).toBe("signal");
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
		const config = makeSignalConfig();
		const channel = new SignalChannel(config as never, deps);

		// start() will try to verify signal-cli and start polling
		// Both may fail in test env, but event bus subscription happens
		try {
			await channel.start();
		} catch {
			// Expected in test env
		}

		expect(subscribe).toHaveBeenCalledTimes(1);
		channel.stop();
	});

	test("allowFrom filter by phone number", async () => {
		const deps = makeMockDeps();
		const config = makeSignalConfig({ allowFrom: ["+15551111111"] });
		const channel = new SignalChannel(config as never, deps);

		// Simulate handleEnvelope with an unauthorized sender
		const unauthorized = {
			envelope: {
				source: "+15559999999",
				dataMessage: {
					timestamp: Date.now(),
					message: "hello",
				},
			},
		};

		await (
			channel as unknown as { handleEnvelope: (output: unknown) => Promise<void> }
		).handleEnvelope(unauthorized);

		expect(deps.runner.submit).not.toHaveBeenCalled();

		// Now with an authorized sender
		const authorized = {
			envelope: {
				source: "+15551111111",
				dataMessage: {
					timestamp: Date.now(),
					message: "hello",
				},
			},
		};

		await (
			channel as unknown as { handleEnvelope: (output: unknown) => Promise<void> }
		).handleEnvelope(authorized);

		expect(deps.runner.submit).toHaveBeenCalledTimes(1);
	});

	test("allowFrom normalizes phone numbers for comparison", async () => {
		const deps = makeMockDeps();
		const config = makeSignalConfig({ allowFrom: ["+1 (555) 111-1111"] });
		const channel = new SignalChannel(config as never, deps);

		const envelope = {
			envelope: {
				source: "+15551111111",
				dataMessage: {
					timestamp: Date.now(),
					message: "run: test task",
				},
			},
		};

		await (
			channel as unknown as { handleEnvelope: (output: unknown) => Promise<void> }
		).handleEnvelope(envelope);

		// After normalization both should be +15551111111
		expect(deps.runner.submit).toHaveBeenCalledTimes(1);
	});
});
