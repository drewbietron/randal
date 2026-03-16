import { describe, expect, test } from "bun:test";
import { parseConfig } from "@randal/core";
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
		// Dashboard is loaded from the actual file or fallback
		expect(html).toContain("Randal");
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
