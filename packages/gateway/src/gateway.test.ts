import { describe, expect, test } from "bun:test";
import { type RunnerEvent, parseConfig } from "@randal/core";
import { Runner } from "@randal/runner";
import { createHttpApp } from "./channels/http.js";
import { EventBus } from "./events.js";

function makeTestApp() {
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

	const app = createHttpApp({ config, runner, eventBus });
	return { app, config, runner, eventBus };
}

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
			headers: { Authorization: "Bearer test-token" },
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
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const jobs = await res.json();
		expect(Array.isArray(jobs)).toBe(true);
	});

	test("GET /job/:id returns 404 for unknown", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/job/nonexistent", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	test("DELETE /job/:id returns 404 for unknown", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/job/nonexistent", {
			method: "DELETE",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	test("GET /config returns sanitized config with skills", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/config", {
			headers: { Authorization: "Bearer test-token" },
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
		expect(html).toContain("<title>Randal Dashboard</title>");
		expect(html).toContain('fetch("/auth/session"');
		expect(html).toContain("unlock to view live coordination state");
		expect(html).not.toContain('<div class="ft">powered by randal</div>');
	});

	test("GET /events opens SSE via session cookie and emits an initial ping", async () => {
		const { app } = makeTestApp();
		const sessionRes = await app.request("/auth/session", {
			method: "POST",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(sessionRes.status).toBe(200);

		const sessionCookie = sessionRes.headers.get("set-cookie");
		expect(sessionCookie).toContain("randal_session=");

		const res = await app.request("/events", {
			headers: { Cookie: sessionCookie ?? "" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(res.body).toBeDefined();
		if (!res.body) throw new Error("Expected SSE response body");

		const reader = res.body.getReader();
		const firstChunk = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for initial SSE frame")), 1000);
			}),
		]);

		expect(firstChunk.done).toBe(false);
		const payload = new TextDecoder().decode(firstChunk.value);
		expect(payload).toContain("event: ping");

		await reader.cancel();
	});

	test("GET /skills returns empty when no skill manager", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const skills = await res.json();
		expect(Array.isArray(skills)).toBe(true);
		expect(skills).toHaveLength(0);
	});

	test("GET /skills/search requires q parameter", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills/search", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBe("q parameter required");
	});

	test("GET /skills/:name returns 400 when no skill manager", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/skills/nonexistent", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(400);
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
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toBe("Not a posse member");
	});

	test("GET /posse returns posse info when configured", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse", {
			headers: { Authorization: "Bearer test-token" },
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
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	test("GET /posse/memory/search requires q parameter", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/search", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(400);
	});

	test("GET /posse/memory/search?scope=self returns empty without memory manager", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/search?q=test&scope=self", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
	});

	test("GET /posse/memory/recent returns 404 when no posse", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/posse/memory/recent", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
	});

	test("GET /posse/memory/recent returns empty without memory manager", async () => {
		const { app } = makePosseTestApp();
		const res = await app.request("/posse/memory/recent?scope=self", {
			headers: { Authorization: "Bearer test-token" },
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
	test("POST /_internal/events emits brain event to EventBus", async () => {
		const { app, eventBus } = makeTestApp();
		const events: RunnerEvent[] = [];
		eventBus.subscribe((e) => events.push(e));

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "notification" }),
		});

		expect(res.status).toBe(400);
	});

	test("POST /_internal/events rejects invalid type", async () => {
		const { app } = makeTestApp();

		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
			headers: { "Content-Type": "application/json" },
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
			headers: { "Content-Type": "application/json" },
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
			headers: { "Content-Type": "application/json" },
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
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "alert",
				jobId: "multi-type",
				message: "alert",
			}),
		});
		expect(res2.status).toBe(200);
	});

	test("POST /_internal/events does not require auth token", async () => {
		const { app } = makeTestApp();

		// No Authorization header — should still work (internal endpoint)
		const res = await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "notification",
				jobId: "no-auth",
				message: "no auth needed",
			}),
		});
		expect(res.status).toBe(200);
	});

	test("POST /_internal/events includes severity in emitted event", async () => {
		const { app, eventBus } = makeTestApp();
		const events: RunnerEvent[] = [];
		eventBus.subscribe((e) => events.push(e));

		await app.request("/_internal/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
			headers: { "Content-Type": "application/json" },
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
