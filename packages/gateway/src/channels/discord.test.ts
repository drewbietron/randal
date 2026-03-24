import { describe, expect, mock, test } from "bun:test";
import type { RunnerEvent } from "@randal/core";
import { EventBus } from "../events.js";
import type { ChannelDeps } from "./channel.js";
import { formatEvent, handleCommand } from "./channel.js";
import { DiscordChannel } from "./discord.js";

// ── Mock helpers ────────────────────────────────────────────

function makeChannelConfig(overrides: Record<string, unknown> = {}) {
	return {
		type: "discord" as const,
		token: "test-token",
		...overrides,
	};
}

function makeDeps(overrides: Record<string, unknown> = {}): ChannelDeps {
	const eventBus = new EventBus();
	return {
		config: {
			gateway: { channels: [] },
		} as unknown as ChannelDeps["config"],
		runner: {
			execute: mock(() => Promise.resolve({ id: "abc1", status: "complete" })),
			submit: mock(() => ({
				jobId: "abc1",
				done: Promise.resolve({ id: "abc1", status: "complete" }),
			})),
			getActiveJobs: mock(() => [
				{ id: "abc1", status: "running", iterations: { current: 1 }, maxIterations: 5 },
			]),
			getJob: mock(() => undefined),
			stop: mock(() => true),
		} as unknown as ChannelDeps["runner"],
		eventBus,
		...overrides,
	};
}

function makeEvent(type: string, jobId = "test-id", data: RunnerEvent["data"] = {}): RunnerEvent {
	return {
		type: type as RunnerEvent["type"],
		jobId,
		timestamp: new Date().toISOString(),
		data,
	};
}

// ── handleCommand tests (shared logic used by Discord) ──────

describe("handleCommand", () => {
	test("handles run command", async () => {
		const deps = makeDeps();
		const origin = { channel: "discord", replyTo: "ch-1", from: "user-1" };
		const result = await handleCommand("run: hello world", deps, origin);
		expect(result).toContain("Job `abc1`");
		expect(result).toContain("started");
		expect(deps.runner.submit).toHaveBeenCalledTimes(1);
	});

	test("treats unrecognized text as implicit run", async () => {
		const deps = makeDeps();
		const origin = { channel: "discord", replyTo: "ch-1", from: "user-1" };
		const result = await handleCommand("refactor the auth module", deps, origin);
		expect(result).toContain("Job `abc1`");
		expect(deps.runner.submit).toHaveBeenCalledTimes(1);
	});

	test("handles status command", async () => {
		const deps = makeDeps();
		const origin = { channel: "discord", replyTo: "ch-1", from: "user-1" };
		const result = await handleCommand("status", deps, origin);
		expect(result).toContain("abc1");
		expect(result).toContain("running");
	});

	test("handles stop command", async () => {
		const deps = makeDeps();
		const origin = { channel: "discord", replyTo: "ch-1", from: "user-1" };
		const result = await handleCommand("stop", deps, origin);
		expect(result).toContain("stopped");
	});

	test("handles help command", async () => {
		const deps = makeDeps();
		const origin = { channel: "discord", replyTo: "ch-1", from: "user-1" };
		const result = await handleCommand("help", deps, origin);
		expect(result).toContain("run:");
		expect(result).toContain("status");
		expect(result).toContain("stop");
	});

	test("handles memory command when not available", async () => {
		const deps = makeDeps();
		const origin = { channel: "discord", replyTo: "ch-1", from: "user-1" };
		const result = await handleCommand("memory: search term", deps, origin);
		expect(result).toBe("Memory not available");
	});

	test("handles run command with empty args", async () => {
		const deps = makeDeps();
		const origin = { channel: "discord", replyTo: "ch-1", from: "user-1" };
		const result = await handleCommand("run:", deps, origin);
		expect(result).toContain("Usage");
	});
});

// ── formatEvent tests ───────────────────────────────────────

describe("formatEvent", () => {
	test("formats job.complete event", () => {
		const event = makeEvent("job.complete", "abc1", { iteration: 3, duration: 120 });
		const result = formatEvent(event);
		expect(result).toContain("abc1");
		expect(result).toContain("complete");
		expect(result).toContain("3 iterations");
		expect(result).toContain("120s");
	});

	test("formats job.failed event", () => {
		const event = makeEvent("job.failed", "abc1", { error: "out of memory" });
		const result = formatEvent(event);
		expect(result).toContain("abc1");
		expect(result).toContain("failed");
		expect(result).toContain("out of memory");
	});

	test("formats job.stuck event", () => {
		const event = makeEvent("job.stuck", "abc1", {
			struggleIndicators: ["no file changes", "repeated errors"],
		});
		const result = formatEvent(event);
		expect(result).toContain("stuck");
		expect(result).toContain("no file changes");
	});

	test("formats iteration.end event", () => {
		const event = makeEvent("iteration.end", "abc1", {
			iteration: 2,
			maxIterations: 5,
			summary: "refactored auth",
		});
		const result = formatEvent(event);
		expect(result).toContain("2/5");
		expect(result).toContain("refactored auth");
	});

	test("formats unknown event type", () => {
		const event = makeEvent("job.queued", "abc1");
		const result = formatEvent(event);
		expect(result).toContain("job.queued");
		expect(result).toContain("abc1");
	});
});

// ── DiscordChannel unit tests ───────────────────────────────

describe("DiscordChannel", () => {
	test("constructs without errors", () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new DiscordChannel(config, deps);
		expect(channel.name).toBe("discord");
	});

	test("sendReply splits long messages", async () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new DiscordChannel(config, deps);

		const sentMessages: string[] = [];
		const mockChannel = {
			send: mock((text: string) => {
				sentMessages.push(text);
				return Promise.resolve();
			}),
		};

		// Generate a message > 2000 chars
		const longMessage = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(50)}`).join(
			"\n",
		);
		expect(longMessage.length).toBeGreaterThan(2000);

		await channel.sendReply(
			mockChannel as { send(content: string): Promise<unknown> },
			longMessage,
		);
		expect(sentMessages.length).toBeGreaterThan(1);

		// All chunks should be <= 2000 chars
		for (const chunk of sentMessages) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
		}
	});

	test("sendReply sends short messages in one call", async () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new DiscordChannel(config, deps);

		const sentMessages: string[] = [];
		const mockChannel = {
			send: mock((text: string) => {
				sentMessages.push(text);
				return Promise.resolve();
			}),
		};

		await channel.sendReply(
			mockChannel as { send(content: string): Promise<unknown> },
			"short message",
		);
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]).toBe("short message");
	});

	test("stop can be called safely", () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new DiscordChannel(config, deps);

		// stop() should not throw even before start
		expect(() => channel.stop()).not.toThrow();
	});

	test("indexes server configs by guild ID", () => {
		const config = makeChannelConfig({
			servers: [
				{
					guildId: "guild-1",
					agent: "ops-agent",
					model: "anthropic/claude-sonnet-4",
					instructions: "You are a DevOps assistant",
					commands: [
						{ name: "deploy", description: "Deploy a service", options: [] },
						{ name: "rollback", description: "Rollback", options: [] },
					],
				},
				{
					guildId: "guild-2",
					commands: [
						{ name: "draft", description: "Create a draft", options: [] },
					],
				},
			],
		});
		const deps = makeDeps();
		const channel = new DiscordChannel(config, deps);

		// Server configs are indexed
		const s1 = channel.getServerConfig("guild-1");
		expect(s1).toBeDefined();
		expect(s1!.agent).toBe("ops-agent");
		expect(s1!.commands).toHaveLength(2);

		const s2 = channel.getServerConfig("guild-2");
		expect(s2).toBeDefined();
		expect(s2!.commands).toHaveLength(1);

		// Non-existent guild returns undefined
		expect(channel.getServerConfig("guild-999")).toBeUndefined();
	});

	test("tracks custom command names across all servers", () => {
		const config = makeChannelConfig({
			servers: [
				{
					guildId: "guild-1",
					commands: [
						{ name: "deploy", description: "Deploy", options: [] },
						{ name: "rollback", description: "Rollback", options: [] },
					],
				},
				{
					guildId: "guild-2",
					commands: [
						{ name: "draft", description: "Draft", options: [] },
					],
				},
			],
		});
		const deps = makeDeps();
		const channel = new DiscordChannel(config, deps);

		const names = channel.getCustomCommandNames();
		expect(names.has("deploy")).toBe(true);
		expect(names.has("rollback")).toBe(true);
		expect(names.has("draft")).toBe(true);
		expect(names.has("run")).toBe(false); // global, not custom
	});

	test("handles empty servers array", () => {
		const config = makeChannelConfig({ servers: [] });
		const deps = makeDeps();
		const channel = new DiscordChannel(config, deps);

		expect(channel.getCustomCommandNames().size).toBe(0);
		expect(channel.getServerConfig("any")).toBeUndefined();
	});

	test("handles missing servers field (defaults to empty)", () => {
		const config = makeChannelConfig();
		const deps = makeDeps();
		const channel = new DiscordChannel(config, deps);

		expect(channel.getCustomCommandNames().size).toBe(0);
	});
});
