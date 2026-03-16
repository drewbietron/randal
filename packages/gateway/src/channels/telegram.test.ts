import { describe, expect, mock, test } from "bun:test";
import type { ChannelDeps } from "./channel.js";
import { TelegramChannel } from "./telegram.js";

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

function makeTelegramConfig(overrides: Record<string, unknown> = {}) {
	return {
		type: "telegram" as const,
		token: "fake-token-123",
		allowFrom: [] as string[],
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────

describe("TelegramChannel", () => {
	test("adapter name is 'telegram'", () => {
		const config = makeTelegramConfig();
		const deps = makeMockDeps();
		const channel = new TelegramChannel(config as never, deps);
		expect(channel.name).toBe("telegram");
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
		const config = makeTelegramConfig();
		const channel = new TelegramChannel(config as never, deps);

		// start() will fail because telegraf is not installed in test,
		// but it should still subscribe to events
		try {
			await channel.start();
		} catch {
			// Expected: telegraf dynamic import may fail in test env
		}

		// The channel subscribes to the event bus during start
		expect(subscribe).toHaveBeenCalledTimes(1);

		// stop() should clean up
		channel.stop();
	});

	test("allowFrom filter blocks unauthorized users", async () => {
		const deps = makeMockDeps();
		const config = makeTelegramConfig({ allowFrom: ["111111"] });
		const channel = new TelegramChannel(config as never, deps);

		// Access the private onTextMessage via a simulated ctx
		// The allowFrom check happens inside onTextMessage, which checks
		// msg.from.id against the allowFrom list
		const replySpy = mock(() => Promise.resolve());
		const ctx = {
			message: {
				text: "hello",
				from: { id: 999999, username: "unauthorized" },
				chat: { id: 123, type: "private" },
			},
			reply: replySpy,
		};

		// Call the private handler via prototype
		await (channel as unknown as { onTextMessage: (ctx: unknown) => Promise<void> }).onTextMessage(
			ctx,
		);

		// Should NOT have replied (user 999999 not in allowFrom)
		expect(replySpy).not.toHaveBeenCalled();
		expect(deps.runner.submit).not.toHaveBeenCalled();
	});

	test("allowFrom filter allows authorized users", async () => {
		const deps = makeMockDeps();
		const config = makeTelegramConfig({ allowFrom: ["111111"] });
		const channel = new TelegramChannel(config as never, deps);

		const replySpy = mock(() => Promise.resolve());
		const ctx = {
			message: {
				text: "hello",
				from: { id: 111111, username: "authorized" },
				chat: { id: 123, type: "private" },
			},
			reply: replySpy,
		};

		await (channel as unknown as { onTextMessage: (ctx: unknown) => Promise<void> }).onTextMessage(
			ctx,
		);

		// Should have replied (user 111111 is in allowFrom)
		expect(replySpy).toHaveBeenCalled();
	});

	test("message commands are routed through handleCommand", async () => {
		const submitMock = mock(() => ({ jobId: "job-42", done: Promise.resolve() }));
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
		});
		const config = makeTelegramConfig();
		const channel = new TelegramChannel(config as never, deps);

		const replySpy = mock(() => Promise.resolve());
		const ctx = {
			message: {
				text: "run: build the API",
				from: { id: 42, username: "dev" },
				chat: { id: 100, type: "private" },
			},
			reply: replySpy,
		};

		await (channel as unknown as { onTextMessage: (ctx: unknown) => Promise<void> }).onTextMessage(
			ctx,
		);

		expect(submitMock).toHaveBeenCalledTimes(1);
		expect(replySpy).toHaveBeenCalled();
		const replyText = (replySpy.mock.calls as unknown[][])[0][0] as string;
		expect(replyText).toContain("job-42");
	});
});
