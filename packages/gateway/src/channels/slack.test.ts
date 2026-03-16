import { describe, expect, mock, test } from "bun:test";
import type { ChannelDeps } from "./channel.js";
import { SlackChannel } from "./slack.js";

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

function makeSlackConfig(overrides: Record<string, unknown> = {}) {
	return {
		type: "slack" as const,
		botToken: "xoxb-fake",
		appToken: "xapp-fake",
		signingSecret: "fake-secret",
		allowFrom: [] as string[],
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────────

describe("SlackChannel", () => {
	test("adapter name is 'slack'", () => {
		const config = makeSlackConfig();
		const deps = makeMockDeps();
		const channel = new SlackChannel(config as never, deps);
		expect(channel.name).toBe("slack");
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
		const config = makeSlackConfig();
		const channel = new SlackChannel(config as never, deps);

		try {
			await channel.start();
		} catch {
			// Expected: @slack/bolt dynamic import may fail in test env
		}

		expect(subscribe).toHaveBeenCalledTimes(1);
		channel.stop();
	});

	test("allowFrom filter blocks unauthorized users in DM", async () => {
		const deps = makeMockDeps();
		const config = makeSlackConfig({ allowFrom: ["U_ALLOWED"] });
		const channel = new SlackChannel(config as never, deps);

		const saySpy = mock(() => Promise.resolve());
		const event = {
			text: "hello",
			user: "U_BLOCKED",
			channel: "D123",
			ts: "123.456",
			channel_type: "im",
		};

		await (
			channel as unknown as {
				onMessage: (event: unknown, say: unknown) => Promise<void>;
			}
		).onMessage(event, saySpy);

		expect(saySpy).not.toHaveBeenCalled();
		expect(deps.runner.submit).not.toHaveBeenCalled();
	});

	test("allowFrom filter allows authorized users", async () => {
		const deps = makeMockDeps();
		const config = makeSlackConfig({ allowFrom: ["U_ALLOWED"] });
		const channel = new SlackChannel(config as never, deps);

		const saySpy = mock(() => Promise.resolve());
		const event = {
			text: "help",
			user: "U_ALLOWED",
			channel: "D123",
			ts: "123.456",
			channel_type: "im",
		};

		await (
			channel as unknown as {
				onMessage: (event: unknown, say: unknown) => Promise<void>;
			}
		).onMessage(event, saySpy);

		expect(saySpy).toHaveBeenCalled();
	});

	test("slash command parsing routes text through handleCommand", async () => {
		const submitMock = mock(() => ({ jobId: "job-slack-1", done: Promise.resolve() }));
		const deps = makeMockDeps({
			runner: {
				submit: submitMock,
				getJob: mock(() => null),
				getActiveJobs: mock(() => []),
				stop: mock(() => true),
			} as unknown as ChannelDeps["runner"],
		});
		const config = makeSlackConfig();
		const channel = new SlackChannel(config as never, deps);

		const ackSpy = mock(() => Promise.resolve());
		const saySpy = mock(() => Promise.resolve());
		const command = {
			command: "/randal",
			text: "run: deploy the service",
			user_id: "U123",
			channel_id: "C456",
			trigger_id: "trig-1",
		};

		await (
			channel as unknown as {
				onSlashCommand: (cmd: unknown, ack: unknown, say: unknown) => Promise<void>;
			}
		).onSlashCommand(command, ackSpy, saySpy);

		// Should acknowledge immediately
		expect(ackSpy).toHaveBeenCalledTimes(1);
		// Should call handleCommand which calls runner.submit
		expect(submitMock).toHaveBeenCalledTimes(1);
		// Should reply with job ID
		expect(saySpy).toHaveBeenCalled();
		const replyText = (saySpy.mock.calls as unknown[][])[0][0] as string;
		expect(replyText).toContain("job-slack-1");
	});
});
