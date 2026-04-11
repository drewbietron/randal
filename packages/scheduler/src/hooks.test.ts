import { describe, expect, mock, test } from "bun:test";
import type { Runner } from "@randal/runner";
import { Heartbeat } from "./heartbeat.js";
import { createHooksRouter } from "./hooks.js";

function createMockRunner() {
	return {
		execute: mock(() => Promise.resolve({})),
		getJob: mock(() => undefined),
		getActiveJobs: mock(() => []),
		stop: mock(() => false),
	} as unknown as Runner;
}

function createMockHeartbeat(runner: Runner) {
	return new Heartbeat({
		config: {
			enabled: true,
			every: "30m",
			prompt: "Test prompt",
			target: "none",
		},
		runner,
	});
}

describe("createHooksRouter", () => {
	test("returns 403 when no token configured", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);

		const app = createHooksRouter({
			token: undefined,
			heartbeat,
			runner,
		});

		const res = await app.request("/wake", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "test", mode: "now" }),
		});

		expect(res.status).toBe(403);
	});

	test("returns 401 with invalid token", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);

		const app = createHooksRouter({
			token: "valid-token",
			heartbeat,
			runner,
		});

		const res = await app.request("/wake", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: JSON.stringify({ text: "test", mode: "now" }),
		});

		expect(res.status).toBe(401);
	});

	test("wake endpoint with mode now triggers heartbeat", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);
		const triggerNowSpy = mock(() => Promise.resolve());
		heartbeat.triggerNow = triggerNowSpy;

		const app = createHooksRouter({
			token: "test-token",
			heartbeat,
			runner,
		});

		const res = await app.request("/wake", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ text: "urgent item", mode: "now" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; mode: string };
		expect(body.ok).toBe(true);
		expect(body.mode).toBe("now");
		expect(triggerNowSpy).toHaveBeenCalledWith("urgent item");
	});

	test("wake endpoint with mode next-heartbeat queues item", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);
		const queueSpy = mock(() => {});
		heartbeat.queueWakeItem = queueSpy;

		const app = createHooksRouter({
			token: "test-token",
			heartbeat,
			runner,
		});

		const res = await app.request("/wake", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ text: "queued item", mode: "next-heartbeat" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; mode: string };
		expect(body.ok).toBe(true);
		expect(body.mode).toBe("next-heartbeat");
		expect(queueSpy).toHaveBeenCalled();
	});

	test("agent endpoint with wakeMode now submits job", async () => {
		const executeMock = mock(() => Promise.resolve({}));
		const runner = {
			execute: executeMock,
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as Runner;

		const heartbeat = createMockHeartbeat(runner);

		const app = createHooksRouter({
			token: "test-token",
			heartbeat,
			runner,
		});

		const res = await app.request("/agent", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				message: "Summarize the inbox",
				wakeMode: "now",
				model: "anthropic/claude-haiku-4",
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; wakeMode: string };
		expect(body.ok).toBe(true);
		expect(body.wakeMode).toBe("now");
		expect(executeMock).toHaveBeenCalled();
	});

	test("agent endpoint with wakeMode next-heartbeat queues", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);
		const queueSpy = mock(() => {});
		heartbeat.queueWakeItem = queueSpy;

		const app = createHooksRouter({
			token: "test-token",
			heartbeat,
			runner,
		});

		const res = await app.request("/agent", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({
				message: "Queue this for later",
				wakeMode: "next-heartbeat",
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; wakeMode: string };
		expect(body.ok).toBe(true);
		expect(body.wakeMode).toBe("next-heartbeat");
		expect(queueSpy).toHaveBeenCalled();
	});

	test("x-randal-token header works for auth", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);
		heartbeat.triggerNow = mock(() => Promise.resolve());

		const app = createHooksRouter({
			token: "test-token",
			heartbeat,
			runner,
		});

		const res = await app.request("/wake", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-randal-token": "test-token",
			},
			body: JSON.stringify({ text: "test", mode: "now" }),
		});

		expect(res.status).toBe(200);
	});

	test("rejects token that shares a prefix with valid token", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);

		const app = createHooksRouter({
			token: "abcdef123456",
			heartbeat,
			runner,
		});

		const res = await app.request("/wake", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer abcdef999999",
			},
			body: JSON.stringify({ text: "test", mode: "now" }),
		});

		expect(res.status).toBe(401);
	});

	test("rejects oversized request body with 413", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);

		const app = createHooksRouter({
			token: "test-token",
			heartbeat,
			runner,
		});

		// Generate a body larger than 1MB
		const largeBody = JSON.stringify({
			text: "x".repeat(1.5 * 1024 * 1024),
			mode: "now",
		});

		const res = await app.request("/wake", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: largeBody,
		});

		expect(res.status).toBe(413);
	});

	test("agent fire-and-forget returns 200 immediately for hung job", async () => {
		// Create a runner that never resolves
		const neverResolve = new Promise(() => {});
		const runner = {
			execute: mock(() => neverResolve),
			getJob: mock(() => undefined),
			getActiveJobs: mock(() => []),
			stop: mock(() => false),
		} as unknown as Runner;

		const heartbeat = createMockHeartbeat(runner);

		const app = createHooksRouter({
			token: "test-token",
			heartbeat,
			runner,
		});

		const res = await app.request("/agent", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ message: "will hang", wakeMode: "now" }),
		});

		// Should still return 200 immediately (fire-and-forget with timeout guard)
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; wakeMode: string };
		expect(body.ok).toBe(true);
		expect(body.wakeMode).toBe("now");
	});

	test("emits hook events", async () => {
		const runner = createMockRunner();
		const heartbeat = createMockHeartbeat(runner);
		heartbeat.triggerNow = mock(() => Promise.resolve());

		const events: Array<{ type: string }> = [];

		const app = createHooksRouter({
			token: "test-token",
			heartbeat,
			runner,
			onEvent: (event) => {
				events.push(event);
			},
		});

		await app.request("/wake", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify({ text: "test", mode: "now" }),
		});

		expect(events.some((e) => e.type === "hook.received")).toBe(true);
	});
});
