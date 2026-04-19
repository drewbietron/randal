import { describe, expect, mock, test } from "bun:test";
import type { RunnerEvent } from "@randal/core";
import {
	EmailChannel,
	SignalChannel,
	SlackChannel,
	TelegramChannel,
	VoiceChannel,
	WhatsAppChannel,
	formatEvent,
} from "@randal/gateway";
import type { ChannelDeps } from "@randal/gateway";

// ── Helpers ─────────────────────────────────────────────────

function makeMockDeps(): ChannelDeps {
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
	};
}

// ── Tests ───────────────────────────────────────────────────

describe("multi-channel E2E", () => {
	test("different channel types can be constructed", () => {
		const deps = makeMockDeps();

		const telegram = new TelegramChannel(
			{ type: "telegram", token: "fake", allowFrom: [] } as never,
			deps,
		);
		expect(telegram.name).toBe("telegram");

		const slack = new SlackChannel(
			{
				type: "slack",
				botToken: "xoxb-fake",
				appToken: "xapp-fake",
				signingSecret: "secret",
				allowFrom: [],
			} as never,
			deps,
		);
		expect(slack.name).toBe("slack");

		const email = new EmailChannel(
			{
				type: "email",
				imap: { host: "imap.test.com", port: 993, tls: true, user: "u", password: "p" },
				smtp: { host: "smtp.test.com", port: 587, secure: false, user: "u", password: "p" },
				allowFrom: [],
			} as never,
			deps,
		);
		expect(email.name).toBe("email");

		const whatsapp = new WhatsAppChannel(
			{
				type: "whatsapp",
				provider: "twilio",
				phoneNumber: "+1555",
				accountSid: "AC",
				authToken: "token",
				allowFrom: [],
			} as never,
			deps,
		);
		expect(whatsapp.name).toBe("whatsapp");

		const signal = new SignalChannel(
			{
				type: "signal",
				phoneNumber: "+1555",
				signalCliBin: "signal-cli",
				allowFrom: [],
			} as never,
			deps,
		);
		expect(signal.name).toBe("signal");

		const voice = new VoiceChannel(
			{
				type: "voice",
				provider: "twilio",
				allowFrom: [],
				access: {
					trustedCallers: ["+15551111111", "+15552222222"],
					unknownInbound: "deny",
					defaultExternalGrants: [],
				},
			} as never,
			deps,
		);
		expect(voice.name).toBe("voice");
	});

	test("VoiceChannel session management", async () => {
		const deps = makeMockDeps();
		const voice = new VoiceChannel(
			{
				type: "voice",
				provider: "twilio",
				allowFrom: [],
				access: {
					trustedCallers: ["+15551111111", "+15552222222"],
					unknownInbound: "deny",
					defaultExternalGrants: [],
				},
			} as never,
			deps,
		);

		await voice.start();

		// Register sessions
		const tts1 = mock(() => {});
		const tts2 = mock(() => {});
		voice.registerSession("session-1", "+15551111111", tts1);
		voice.registerSession("session-2", "+15552222222", tts2);

		expect(voice.hasSession("session-1")).toBe(true);
		expect(voice.hasSession("session-2")).toBe(true);
		expect(voice.getActiveSessions()).toHaveLength(2);

		// Unregister one
		voice.unregisterSession("session-1");
		expect(voice.hasSession("session-1")).toBe(false);
		expect(voice.getActiveSessions()).toHaveLength(1);

		// Stop clears all
		voice.stop();
		expect(voice.getActiveSessions()).toHaveLength(0);
	});

	test("formatEvent works for all event types", () => {
		const baseEvent: Omit<RunnerEvent, "type" | "data"> = {
			jobId: "job-123",
			timestamp: new Date().toISOString(),
		};

		// job.complete
		const complete: RunnerEvent = {
			...baseEvent,
			type: "job.complete",
			data: { iteration: 5, duration: 120 },
		};
		expect(formatEvent(complete)).toContain("job-123");
		expect(formatEvent(complete)).toContain("complete");

		// job.failed
		const failed: RunnerEvent = {
			...baseEvent,
			type: "job.failed",
			data: { error: "compilation failed" },
		};
		expect(formatEvent(failed)).toContain("failed");
		expect(formatEvent(failed)).toContain("compilation failed");

		// job.stuck
		const stuck: RunnerEvent = {
			...baseEvent,
			type: "job.stuck",
			data: { struggleIndicators: ["no changes", "repeated errors"] },
		};
		expect(formatEvent(stuck)).toContain("stuck");

		// iteration.end
		const iterEnd: RunnerEvent = {
			...baseEvent,
			type: "iteration.end",
			data: { iteration: 3, maxIterations: 10, summary: "Added tests" },
		};
		expect(formatEvent(iterEnd)).toContain("3/10");
		expect(formatEvent(iterEnd)).toContain("Added tests");

		// job.plan_updated
		const planUpdated: RunnerEvent = {
			...baseEvent,
			type: "job.plan_updated",
			data: {
				plan: [
					{ task: "Setup", status: "completed" },
					{ task: "Build", status: "in_progress" },
					{ task: "Test", status: "pending" },
				],
			},
		};
		expect(formatEvent(planUpdated)).toContain("1/3");

		// job.delegation.started
		const delegStarted: RunnerEvent = {
			...baseEvent,
			type: "job.delegation.started",
			data: { delegationTask: "auth module" },
		};
		expect(formatEvent(delegStarted)).toContain("delegating");
		expect(formatEvent(delegStarted)).toContain("auth module");

		// job.delegation.completed
		const delegCompleted: RunnerEvent = {
			...baseEvent,
			type: "job.delegation.completed",
			data: { delegationTask: "auth module", delegationStatus: "complete" },
		};
		expect(formatEvent(delegCompleted)).toContain("delegation done");

		// Default/unknown event type
		const heartbeat: RunnerEvent = {
			...baseEvent,
			type: "heartbeat.tick",
			data: {},
		};
		expect(formatEvent(heartbeat)).toContain("heartbeat.tick");
	});
});
