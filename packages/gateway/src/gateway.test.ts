import { describe, expect, test } from "bun:test";
import { type RunnerEvent, parseConfig } from "@randal/core";
import { Runner } from "@randal/runner";
import type { ChannelAdapter } from "./channels/channel.js";
import { createHttpApp, type HttpChannelOptions } from "./channels/http.js";
import { EventBus } from "./events.js";

function makeTestApp(
	overrides: Partial<Pick<HttpChannelOptions, "channelAdapters" | "voiceManager">> = {},
) {
	const config = parseConfig(`
name: test-gateway
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
`);

	const eventBus = new EventBus();
	const runner = new Runner({
		config,
		onEvent: (e) => eventBus.emit(e),
	});

	const app = createHttpApp({ config, runner, eventBus, ...overrides });
	return { app, config, runner, eventBus };
}

const authHeaders = { Authorization: "Bearer test-token" };

describe("HTTP API", () => {
	test("GET /health returns ok without auth", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("ok");
	});

	test("GET /health returns ok with auth too", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/health", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("ok");
	});

	test("GET /instance returns info", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/instance", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe("test-gateway");
	});

	test("POST /job requires prompt", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/job", {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("GET /jobs returns empty initially", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/jobs", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const jobs = await res.json();
		expect(Array.isArray(jobs)).toBe(true);
	});

	test("GET /job/:id returns 404 for unknown", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/job/nonexistent", {
			headers: authHeaders,
		});
		expect(res.status).toBe(404);
	});

	test("DELETE /job/:id returns 404 for unknown", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/job/nonexistent", {
			method: "DELETE",
			headers: authHeaders,
		});
		expect(res.status).toBe(404);
	});

	test("GET /config returns sanitized config with skills", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/config", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe("test-gateway");
		expect(data.credentials).toBeDefined();
		expect(data.skills).toBeDefined();
		expect(data.skills.dir).toBe("./skills");
		expect(data.skills.autoDiscover).toBe(true);
		expect(data.skills.maxPerPrompt).toBe(5);
		// Verify no raw credential values are exposed
		const serialized = JSON.stringify(data);
		expect(serialized).not.toContain("test-token");
	});

	test("GET / returns dashboard HTML", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		// Dashboard is loaded from the actual file or fallback
		expect(html).toContain("Randal");
	});

	test("GET /skills returns empty when no skill manager", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const skills = await res.json();
		expect(Array.isArray(skills)).toBe(true);
		expect(skills).toHaveLength(0);
	});

	test("GET /skills/search requires q parameter", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills/search", {
			headers: authHeaders,
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBe("q parameter required");
	});

	test("GET /skills/:name returns 400 when no skill manager", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills/nonexistent", {
			headers: authHeaders,
		});
		expect(res.status).toBe(400);
	});

	test("GET /voice/status requires authentication", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/voice/status");
		expect(res.status).toBe(401);
	});

	test("GET /voice/status returns voice status when authenticated", async () => {
		const { app } = makeTestApp({
			voiceManager: {
				isEnabled: () => true,
				getSessions: () => [
					{
						id: "session-1",
						callId: "call-1",
						status: "active",
						duration: 42,
						transcriptLength: 3,
						startedAt: "2026-04-19T16:00:00.000Z",
					},
				],
			},
		});
		const res = await app.request("/voice/status", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.enabled).toBe(true);
		expect(data.sessions).toHaveLength(1);
	});
});

// ---- Posse endpoint tests ----

function makePosseTestApp() {
	const config = parseConfig(`
name: test-agent
posse: test-team
runner:
  workdir: /tmp
  defaultAgent: mock
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
memory:
  sharing:
    publishTo: "shared-test-team"
    readFrom: ["shared-test-team"]
`);

	const eventBus = new EventBus();
	const runner = new Runner({
		config,
		onEvent: (e) => eventBus.emit(e),
	});

	const app = createHttpApp({ config, runner, eventBus });
	return { app, config, runner, eventBus };
}

describe("Posse HTTP API", () => {
	test("GET /posse returns 404 when posse not configured", async () => {
		const { app } = makeTestApp(); // no posse in config
		const res = await app.request("/posse", {
			headers: authHeaders,
		});
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toBe("Not a posse member");
	});

	test("GET /posse returns posse info when configured", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.posse).toBe("test-team");
		expect(data.self).toBe("test-agent");
		expect(Array.isArray(data.agents)).toBe(true);
	});

	test("GET /posse/memory/search returns 404 when no posse", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/posse/memory/search?q=test", {
			headers: authHeaders,
		});
		expect(res.status).toBe(404);
	});

	test("GET /posse/memory/search requires q parameter", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/search", {
			headers: authHeaders,
		});
		expect(res.status).toBe(400);
	});

	test("GET /posse/memory/search?scope=self returns empty without memory manager", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/search?q=test&scope=self", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
	});

	test("GET /posse/memory/recent returns 404 when no posse", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/posse/memory/recent", {
			headers: authHeaders,
		});
		expect(res.status).toBe(404);
	});

	test("GET /posse/memory/recent returns empty without memory manager", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/recent?scope=self", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
	});

	test("All /posse/* endpoints require authentication", async () => {
		const { app } = makePosseTestApp();

		const endpoints = ["/posse", "/posse/memory/search?q=test", "/posse/memory/recent"];
		for (const ep of endpoints) {
			const res = await app.request(ep);
			expect(res.status).toBe(401);
		}
	});
});

// ---- Internal Events API tests ----

describe("Internal Events API", () => {
	test("GET /_internal/channels requires authentication", async () => {
		const adapter: ChannelAdapter = {
			name: "discord",
			start: async () => {},
			stop: () => {},
		};
		const { app } = makeTestApp({ channelAdapters: [adapter] });
		const res = await app.request("/_internal/channels");
		expect(res.status).toBe(401);
	});

	test("GET /_internal/channels lists adapters when authenticated", async () => {
		const adapter: ChannelAdapter = {
			name: "discord",
			start: async () => {},
			stop: () => {},
			send: async () => {},
		};
		const { app } = makeTestApp({ channelAdapters: [adapter] });
		const res = await app.request("/_internal/channels", {
			headers: authHeaders,
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.channels).toEqual([{ name: "discord", canSend: true }]);
	});

	test("POST /_internal/channel/send requires authentication", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/_internal/channel/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ channel: "discord", target: "123", message: "hello" }),
		});
		expect(res.status).toBe(401);
	});

	test("POST /_internal/channel/send dispatches when authenticated", async () => {
		const sent: Array<{ target: string; message: string }> = [];
		const adapter: ChannelAdapter = {
			name: "discord",
			start: async () => {},
			stop: () => {},
			send: async (target, message) => {
				sent.push({ target, message });
			},
		};
		const { app } = makeTestApp({ channelAdapters: [adapter] });
		const res = await app.request("/_internal/channel/send", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({ channel: "discord", target: "123", message: "hello" }),
		});
		expect(res.status).toBe(200);
		expect(sent).toEqual([{ target: "123", message: "hello" }]);
	});

	test("POST /_internal/events emits brain event to EventBus", async () => {
		const { app, eventBus } = makeTestApp();
		const events: RunnerEvent[] = [];
		eventBus.subscribe((e) => events.push(e));

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "test-job",
				message: "Build complete",
			}),
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.emitted).toBe(true);
		expect(data.type).toBe("brain.notification");

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("brain.notification");
		expect(events[0].jobId).toBe("test-job");
		expect(events[0].data.message).toBe("Build complete");
	});

	test("POST /_internal/events requires type, jobId, message", async () => {
		const { app } = makeTestApp();

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({ type: "notification" }),
		});

		expect(res.status).toBe(400);
	});

	test("POST /_internal/events rejects invalid type", async () => {
		const { app } = makeTestApp();

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "invalid",
				jobId: "test-job",
				message: "hello",
			}),
		});

		expect(res.status).toBe(400);
	});

	test("POST /_internal/events rate limits repeated calls", async () => {
		const { app } = makeTestApp();

		// First call succeeds
		const res1 = await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "rate-test",
				message: "first",
			}),
		});
		expect(res1.status).toBe(200);

		// Second call within 10s is rate limited
		const res2 = await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "rate-test",
				message: "second",
			}),
		});
		expect(res2.status).toBe(429);
		const data = await res2.json();
		expect(data.retryAfterSeconds).toBeGreaterThan(0);
	});

	test("POST /_internal/events allows different types for same job", async () => {
		const { app } = makeTestApp();

		const res1 = await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "multi-type",
				message: "notif",
			}),
		});
		expect(res1.status).toBe(200);

		// Different type for same job should succeed
		const res2 = await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "alert",
				jobId: "multi-type",
				message: "alert",
			}),
		});
		expect(res2.status).toBe(200);
	});

	test("POST /_internal/events requires auth token", async () => {
		const { app } = makeTestApp();

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "no-auth",
				message: "no auth needed",
			}),
		});
		expect(res.status).toBe(401);
	});

	test("POST /_internal/events includes severity in emitted event", async () => {
		const { app, eventBus } = makeTestApp();
		const events: RunnerEvent[] = [];
		eventBus.subscribe((e) => events.push(e));

		await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "alert",
				jobId: "sev-test",
				message: "critical issue",
				severity: "critical",
			}),
		});

		expect(events).toHaveLength(1);
		expect(events[0].data.severity).toBe("critical");
	});

	test("POST /_internal/events → EventBus → subscriber receives formatted event", async () => {
		const { app, eventBus } = makeTestApp();
		const received: string[] = [];

		// Simulate a channel adapter subscribing
		eventBus.subscribe((event) => {
			if (event.type === "brain.alert") {
				const sev = event.data.severity ?? "warning";
				const prefix = sev === "critical" ? "CRITICAL" : "ALERT";
				received.push(`**${prefix}**: ${event.data.message}`);
			}
		});

		await app.request("/_internal/events", {
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "alert",
				jobId: "e2e-test",
				message: "Build stuck on step 7",
				severity: "critical",
			}),
		});

		expect(received).toHaveLength(1);
		expect(received[0]).toBe("**CRITICAL**: Build stuck on step 7");
	});
});
