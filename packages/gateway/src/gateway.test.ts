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
	test("GET /health returns ok", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/health", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.status).toBe("ok");
	});

	test("GET /health requires auth", async () => {
		const { app } = makeTestApp();
		const res = await app.request("/health");
		expect(res.status).toBe(401);
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
