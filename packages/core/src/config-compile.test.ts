import { describe, expect, test } from "bun:test";
import { compileOpenCodeConfig } from "./config-compile.js";
import { configSchema } from "./config.js";
import type { CompileOptions, RandalConfig } from "./index.js";

// ---- Helpers ----

/** Minimal valid config for tests that don't care about identity. */
function minimalConfig(overrides?: Record<string, unknown>): RandalConfig {
	return configSchema.parse({
		name: "test-agent",
		runner: { workdir: "/tmp/test" },
		...overrides,
	}) as RandalConfig;
}

/** Default compile options with deterministic paths. */
function defaultOptions(overrides?: Partial<CompileOptions>): CompileOptions {
	return {
		basePath: "/tmp",
		repoRoot: "/repo",
		toolsDir: "/repo/tools",
		...overrides,
	};
}

// ---- Edge cases ----

describe("edge cases", () => {
	test("empty capabilities produces no MCP servers beyond defaults", () => {
		const config = minimalConfig({
			capabilities: [],
			memory: { store: undefined },
			heartbeat: { enabled: false },
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		// With no memory, no heartbeat, no capabilities, and no TAVILY_API_KEY
		// we should have zero MCP servers (tavily depends on env var or capability)
		const mcpKeys = Object.keys(result.config.mcp);
		// Memory is included by default because memory.store defaults to "meilisearch"
		// Check that at least no video/image-gen/scheduler servers exist
		expect(mcpKeys).not.toContain("video");
		expect(mcpKeys).not.toContain("image-gen");
		expect(mcpKeys).not.toContain("scheduler");
	});

	test("config with no capabilities but memory.store set includes memory MCP", () => {
		const config = minimalConfig({
			capabilities: [],
			memory: { store: "meilisearch", url: "http://localhost:7700" },
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.memory).toBeDefined();
		expect(result.config.mcp.memory.type).toBe("local");
		expect(result.config.mcp.memory.environment?.MEILI_URL).toBe("http://localhost:7700");
	});

	test("empty tools array does not produce tool permissions", () => {
		const config = minimalConfig({
			tools: [],
			capabilities: [],
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(Object.keys(result.config.tools)).toHaveLength(0);
	});

	test("missing optional identity fields do not cause errors", () => {
		const config = minimalConfig({
			identity: {}, // All optional — persona, rules, knowledge all omitted
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		// Should compile without error
		expect(result.config.$schema).toBe("https://opencode.ai/config.json");
		expect(result.resolvedPersona).toBeUndefined();
		expect(result.resolvedRules).toBeUndefined();
		expect(result.resolvedKnowledge).toBeUndefined();
	});

	test("config with only heartbeat enabled includes scheduler MCP", () => {
		const config = minimalConfig({
			capabilities: [],
			heartbeat: { enabled: true },
			gateway: {
				channels: [{ type: "http", port: 7600, auth: "test" }],
			},
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.scheduler).toBeDefined();
		expect(result.config.mcp.scheduler.type).toBe("local");
	});

	test("config with only cron jobs (no heartbeat) includes scheduler MCP", () => {
		const config = minimalConfig({
			capabilities: [],
			heartbeat: { enabled: false },
			cron: {
				jobs: {
					daily: {
						schedule: "0 8 * * *",
						prompt: "Daily task",
					},
				},
			},
			gateway: {
				channels: [{ type: "http", port: 7600, auth: "test" }],
			},
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.scheduler).toBeDefined();
	});

	test("capability 'video' adds video MCP and video_* tool permission", () => {
		const config = minimalConfig({
			capabilities: ["video"],
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.video).toBeDefined();
		expect(result.config.mcp.video.type).toBe("local");
		expect(result.config.tools["video_*"]).toBe(true);
	});

	test("capability 'image-gen' adds image-gen MCP and image-gen_* tool permission", () => {
		const config = minimalConfig({
			capabilities: ["image-gen"],
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp["image-gen"]).toBeDefined();
		expect(result.config.tools["image-gen_*"]).toBe(true);
	});

	test("capability 'search' adds tavily MCP", () => {
		const config = minimalConfig({
			capabilities: ["search"],
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.tavily).toBeDefined();
		expect(result.config.mcp.tavily.type).toBe("remote");
	});

	test("tool named 'video' in tools array acts like video capability", () => {
		const config = minimalConfig({
			capabilities: [],
			tools: [{ name: "video", binary: "video-server", platforms: ["darwin", "linux"] }],
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.video).toBeDefined();
		expect(result.config.tools["video_*"]).toBe(true);
	});

	test("compile result is JSON-serializable", () => {
		const config = minimalConfig({
			capabilities: ["search", "video", "image-gen"],
			heartbeat: { enabled: true },
			gateway: {
				channels: [{ type: "http", port: 7600, auth: "test" }],
			},
		});
		const result = compileOpenCodeConfig(config, defaultOptions());

		// Should round-trip through JSON without loss
		const serialized = JSON.stringify(result.config);
		const deserialized = JSON.parse(serialized);
		expect(deserialized.$schema).toBe(result.config.$schema);
		expect(deserialized.plugin).toEqual(result.config.plugin);
		expect(Object.keys(deserialized.mcp).sort()).toEqual(Object.keys(result.config.mcp).sort());
	});

	test("base template fields are preserved in output", () => {
		const config = minimalConfig();
		const result = compileOpenCodeConfig(config, defaultOptions());

		// Fields from opencode.base.json must survive
		expect(result.config.$schema).toBe("https://opencode.ai/config.json");
		expect(result.config.plugin).toEqual(["opencode-claude-auth"]);
		expect(result.config.agent.build.disable).toBe(true);
		expect(result.config.agent.plan.disable).toBe(true);
	});

	test("resolvedIdentity with vars applies interpolation", () => {
		const config = minimalConfig({
			identity: {
				vars: { agent_name: "TestBot", version: "2.0" },
			},
		});
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				persona: "I am {{agent_name}} version {{version}}",
				rules: ["Rule for {{agent_name}}", "Static rule"],
				knowledge: ["Knowledge about {{agent_name}}"],
			},
		});

		expect(result.resolvedPersona).toBe("I am TestBot version 2.0");
		expect(result.resolvedRules).toEqual(["Rule for TestBot", "Static rule"]);
		expect(result.resolvedKnowledge).toEqual(["Knowledge about TestBot"]);
	});

	test("resolvedIdentity without vars passes content through", () => {
		const config = minimalConfig();
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				persona: "Hello {{unknown_var}}",
			},
		});

		// Unknown vars are left as-is
		expect(result.resolvedPersona).toBe("Hello {{unknown_var}}");
	});

	test("no resolvedIdentity means no identity metadata in result", () => {
		const config = minimalConfig();
		const result = compileOpenCodeConfig(config, defaultOptions());

		expect(result.resolvedPersona).toBeUndefined();
		expect(result.resolvedRules).toBeUndefined();
		expect(result.resolvedKnowledge).toBeUndefined();
	});

	test("toolsDir falls back to repoRoot/tools when not explicitly set", () => {
		const config = minimalConfig({
			capabilities: ["video"],
		});
		const result = compileOpenCodeConfig(config, {
			basePath: "/tmp",
			repoRoot: "/my/repo",
			// toolsDir intentionally omitted
		});
		const videoCmd = result.config.mcp.video.command ?? [];
		expect(videoCmd[2]).toBe("/my/repo/tools/video/mcp-server.ts");
	});

	test("toolsDir falls back to basePath/tools when both repoRoot and toolsDir are missing", () => {
		const config = minimalConfig({
			capabilities: ["video"],
		});
		const result = compileOpenCodeConfig(config, {
			basePath: "/my/workspace",
			// repoRoot and toolsDir both omitted
		});
		const videoCmd = result.config.mcp.video.command ?? [];
		expect(videoCmd[2]).toBe("/my/workspace/tools/video/mcp-server.ts");
	});

	test("memory MCP includes apiKey when configured", () => {
		const config = minimalConfig({
			memory: {
				store: "meilisearch",
				url: "http://localhost:7700",
				apiKey: "my-master-key",
			},
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.memory.environment?.MEILI_API_KEY).toBe("my-master-key");
	});

	test("memory MCP omits apiKey when empty", () => {
		const config = minimalConfig({
			memory: {
				store: "meilisearch",
				url: "http://localhost:7700",
				apiKey: "",
			},
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		// Empty apiKey should not be included
		expect(result.config.mcp.memory.environment?.MEILI_API_KEY).toBeUndefined();
	});

	test("scheduler MCP derives gateway URL from config", () => {
		const config = minimalConfig({
			heartbeat: { enabled: true },
			gateway: {
				channels: [{ type: "http", port: 9999, auth: "test" }],
			},
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.scheduler.environment?.RANDAL_GATEWAY_URL).toBe(
			"http://localhost:9999",
		);
	});

	test("scheduler MCP falls back to default gateway URL when no HTTP channel", () => {
		const config = minimalConfig({
			heartbeat: { enabled: true },
			// No gateway channels
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.mcp.scheduler.environment?.RANDAL_GATEWAY_URL).toBe(
			"http://localhost:7600",
		);
	});
});

// ---- Step 10: MCP wiring conditional inclusion ----

describe("MCP server conditional inclusion", () => {
	describe("memory MCP", () => {
		test("present when memory.store is 'meilisearch'", () => {
			const config = minimalConfig({
				memory: { store: "meilisearch", url: "http://localhost:7700" },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.memory).toBeDefined();
			expect(result.config.mcp.memory.type).toBe("local");
			expect(result.config.mcp.memory.enabled).toBe(true);
		});

		test("always present because memory.store defaults to 'meilisearch'", () => {
			// Note: the config schema defaults memory.store to "meilisearch",
			// so memory MCP is always included unless the compile logic changes.
			const config = minimalConfig(); // no explicit memory config
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.memory).toBeDefined();
			expect(result.config.mcp.memory.type).toBe("local");
		});

		test("environment includes MEILI_URL from config", () => {
			const config = minimalConfig({
				memory: { store: "meilisearch", url: "http://custom-host:9999" },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.memory.environment?.MEILI_URL).toBe("http://custom-host:9999");
		});

		test("environment includes SUMMARY_MODEL", () => {
			const config = minimalConfig({
				memory: { store: "meilisearch", url: "http://localhost:7700" },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.memory.environment?.SUMMARY_MODEL).toBeDefined();
			expect(typeof result.config.mcp.memory.environment?.SUMMARY_MODEL).toBe("string");
		});

		test("environment includes MEILI_API_KEY when configured", () => {
			const config = minimalConfig({
				memory: { store: "meilisearch", url: "http://localhost:7700", apiKey: "secret-key" },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.memory.environment?.MEILI_API_KEY).toBe("secret-key");
		});

		test("environment omits MEILI_API_KEY when empty string", () => {
			const config = minimalConfig({
				memory: { store: "meilisearch", url: "http://localhost:7700", apiKey: "" },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.memory.environment?.MEILI_API_KEY).toBeUndefined();
		});

		test("environment omits MEILI_API_KEY when not provided", () => {
			const config = minimalConfig({
				memory: { store: "meilisearch", url: "http://localhost:7700" },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.memory.environment?.MEILI_API_KEY).toBeUndefined();
		});

		test("command path uses toolsDir", () => {
			const config = minimalConfig({
				memory: { store: "meilisearch", url: "http://localhost:7700" },
			});
			const result = compileOpenCodeConfig(config, defaultOptions({ toolsDir: "/custom/tools" }));
			const cmd = result.config.mcp.memory.command ?? [];
			expect(cmd[2]).toBe("/custom/tools/mcp-memory-server.ts");
		});
	});

	describe("scheduler MCP", () => {
		test("present when heartbeat.enabled is true", () => {
			const config = minimalConfig({
				heartbeat: { enabled: true },
				gateway: { channels: [{ type: "http", port: 7600, auth: "tok" }] },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.scheduler).toBeDefined();
			expect(result.config.mcp.scheduler.type).toBe("local");
			expect(result.config.mcp.scheduler.enabled).toBe(true);
		});

		test("present when cron jobs exist (even if heartbeat disabled)", () => {
			const config = minimalConfig({
				heartbeat: { enabled: false },
				cron: {
					jobs: {
						"my-job": { schedule: "0 9 * * *", prompt: "do thing" },
					},
				},
				gateway: { channels: [{ type: "http", port: 7600, auth: "tok" }] },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.scheduler).toBeDefined();
		});

		test("absent when heartbeat disabled AND no cron jobs", () => {
			const config = minimalConfig({
				heartbeat: { enabled: false },
				cron: { jobs: {} },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.scheduler).toBeUndefined();
		});

		test("environment derives gateway URL from HTTP channel port", () => {
			const config = minimalConfig({
				heartbeat: { enabled: true },
				gateway: { channels: [{ type: "http", port: 8080, auth: "tok" }] },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.scheduler.environment?.RANDAL_GATEWAY_URL).toBe(
				"http://localhost:8080",
			);
		});

		test("environment falls back to default gateway URL when no HTTP channel", () => {
			const config = minimalConfig({
				heartbeat: { enabled: true },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.scheduler.environment?.RANDAL_GATEWAY_URL).toBe(
				"http://localhost:7600",
			);
		});

		test("environment uses {env:RANDAL_GATEWAY_TOKEN} placeholder", () => {
			const config = minimalConfig({
				heartbeat: { enabled: true },
				gateway: { channels: [{ type: "http", port: 7600, auth: "tok" }] },
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.scheduler.environment?.RANDAL_GATEWAY_TOKEN).toBe(
				"{env:RANDAL_GATEWAY_TOKEN}",
			);
		});

		test("command path uses toolsDir", () => {
			const config = minimalConfig({
				heartbeat: { enabled: true },
				gateway: { channels: [{ type: "http", port: 7600, auth: "tok" }] },
			});
			const result = compileOpenCodeConfig(config, defaultOptions({ toolsDir: "/my/tools" }));
			const cmd = result.config.mcp.scheduler.command ?? [];
			expect(cmd[2]).toBe("/my/tools/mcp-scheduler-server.ts");
		});
	});

	describe("tavily MCP", () => {
		test("present when capabilities includes 'search'", () => {
			const config = minimalConfig({ capabilities: ["search"] });
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.tavily).toBeDefined();
			expect(result.config.mcp.tavily.type).toBe("remote");
			expect(result.config.mcp.tavily.enabled).toBe(true);
		});

		test("present when capabilities includes 'tavily'", () => {
			const config = minimalConfig({ capabilities: ["tavily"] });
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.tavily).toBeDefined();
		});

		test("absent when no search capability and no TAVILY_API_KEY", () => {
			// Save and clear env var to ensure clean test
			const savedKey = process.env.TAVILY_API_KEY;
			process.env.TAVILY_API_KEY = "";
			try {
				const config = minimalConfig({ capabilities: [] });
				const result = compileOpenCodeConfig(config, defaultOptions());
				expect(result.config.mcp.tavily).toBeUndefined();
			} finally {
				if (savedKey !== undefined) {
					process.env.TAVILY_API_KEY = savedKey;
				} else {
					process.env.TAVILY_API_KEY = "";
				}
			}
		});

		test("URL includes {env:TAVILY_API_KEY} placeholder (not raw key)", () => {
			const config = minimalConfig({ capabilities: ["search"] });
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.tavily.url).toContain("{env:TAVILY_API_KEY}");
			// Should NOT contain any raw API key value
			expect(result.config.mcp.tavily.url).not.toMatch(/tavilyApiKey=[A-Za-z0-9]{10,}/);
		});
	});

	describe("video MCP", () => {
		test("present when capabilities includes 'video'", () => {
			const config = minimalConfig({ capabilities: ["video"] });
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.video).toBeDefined();
			expect(result.config.mcp.video.type).toBe("local");
			expect(result.config.mcp.video.enabled).toBe(true);
		});

		test("present when tools array contains a tool named 'video'", () => {
			const config = minimalConfig({
				capabilities: [],
				tools: [{ name: "video", binary: "video-srv", platforms: ["darwin"] }],
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.video).toBeDefined();
		});

		test("absent when no video capability or tool", () => {
			const config = minimalConfig({ capabilities: [], tools: [] });
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp.video).toBeUndefined();
		});

		test("command points to video/mcp-server.ts in toolsDir", () => {
			const config = minimalConfig({ capabilities: ["video"] });
			const result = compileOpenCodeConfig(config, defaultOptions({ toolsDir: "/srv/tools" }));
			const cmd = result.config.mcp.video.command ?? [];
			expect(cmd[0]).toBe("bun");
			expect(cmd[1]).toBe("run");
			expect(cmd[2]).toBe("/srv/tools/video/mcp-server.ts");
		});
	});

	describe("image-gen MCP", () => {
		test("present when capabilities includes 'image-gen'", () => {
			const config = minimalConfig({ capabilities: ["image-gen"] });
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp["image-gen"]).toBeDefined();
			expect(result.config.mcp["image-gen"].type).toBe("local");
			expect(result.config.mcp["image-gen"].enabled).toBe(true);
		});

		test("present when tools array contains a tool named 'image-gen'", () => {
			const config = minimalConfig({
				capabilities: [],
				tools: [{ name: "image-gen", binary: "ig-srv", platforms: ["darwin"] }],
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp["image-gen"]).toBeDefined();
		});

		test("absent when no image-gen capability or tool", () => {
			const config = minimalConfig({ capabilities: [], tools: [] });
			const result = compileOpenCodeConfig(config, defaultOptions());
			expect(result.config.mcp["image-gen"]).toBeUndefined();
		});

		test("command points to image-gen/mcp-server.ts in toolsDir", () => {
			const config = minimalConfig({ capabilities: ["image-gen"] });
			const result = compileOpenCodeConfig(config, defaultOptions({ toolsDir: "/srv/tools" }));
			const cmd = result.config.mcp["image-gen"].command ?? [];
			expect(cmd[0]).toBe("bun");
			expect(cmd[1]).toBe("run");
			expect(cmd[2]).toBe("/srv/tools/image-gen/mcp-server.ts");
		});
	});

	describe("multiple MCP servers together", () => {
		test("all five servers present with full capabilities", () => {
			const config = minimalConfig({
				memory: { store: "meilisearch", url: "http://localhost:7700" },
				heartbeat: { enabled: true },
				gateway: { channels: [{ type: "http", port: 7600, auth: "tok" }] },
				capabilities: ["search", "video", "image-gen"],
			});
			const result = compileOpenCodeConfig(config, defaultOptions());
			const keys = Object.keys(result.config.mcp).sort();
			expect(keys).toEqual(["image-gen", "memory", "scheduler", "tavily", "video"]);
		});

		test("only memory MCP when nothing else configured (memory defaults to meilisearch)", () => {
			const savedKey = process.env.TAVILY_API_KEY;
			process.env.TAVILY_API_KEY = "";
			try {
				const config = minimalConfig({
					heartbeat: { enabled: false },
					capabilities: [],
					tools: [],
				});
				const result = compileOpenCodeConfig(config, defaultOptions());
				// memory.store defaults to "meilisearch", so memory MCP is always present
				const keys = Object.keys(result.config.mcp);
				expect(keys).toEqual(["memory"]);
			} finally {
				if (savedKey !== undefined) {
					process.env.TAVILY_API_KEY = savedKey;
				} else {
					process.env.TAVILY_API_KEY = "";
				}
			}
		});
	});
});

// ---- Step 10: Template interpolation ----

describe("template interpolation via identity.vars", () => {
	test("vars are substituted into persona text", () => {
		const config = minimalConfig({
			identity: { vars: { agent_name: "Ava", role: "assistant" } },
		});
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				persona: "I am {{agent_name}}, your {{role}}.",
			},
		});
		expect(result.resolvedPersona).toBe("I am Ava, your assistant.");
	});

	test("vars are substituted into each rule", () => {
		const config = minimalConfig({
			identity: { vars: { project: "acme" } },
		});
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				rules: ["Work on {{project}} only", "Deploy {{project}} to staging", "Static rule no vars"],
			},
		});
		expect(result.resolvedRules).toEqual([
			"Work on acme only",
			"Deploy acme to staging",
			"Static rule no vars",
		]);
	});

	test("vars are substituted into each knowledge entry", () => {
		const config = minimalConfig({
			identity: { vars: { version: "3.0" } },
		});
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				knowledge: ["API version {{version}} docs", "Changelog for {{version}}"],
			},
		});
		expect(result.resolvedKnowledge).toEqual(["API version 3.0 docs", "Changelog for 3.0"]);
	});

	test("unknown variables are left as-is (not stripped)", () => {
		const config = minimalConfig({
			identity: { vars: { known: "yes" } },
		});
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				persona: "{{known}} and {{unknown_var}}",
			},
		});
		expect(result.resolvedPersona).toBe("yes and {{unknown_var}}");
	});

	test("empty vars object leaves all placeholders intact", () => {
		const config = minimalConfig({
			identity: { vars: {} },
		});
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				persona: "Hello {{name}}",
			},
		});
		expect(result.resolvedPersona).toBe("Hello {{name}}");
	});

	test("no identity.vars (undefined) passes content through unmodified", () => {
		const config = minimalConfig(); // identity.vars defaults to {}
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				persona: "Hello {{name}}",
			},
		});
		// With empty vars, {{name}} stays as-is
		expect(result.resolvedPersona).toBe("Hello {{name}}");
	});

	test("no resolvedIdentity returns undefined for all identity fields", () => {
		const config = minimalConfig();
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.resolvedPersona).toBeUndefined();
		expect(result.resolvedRules).toBeUndefined();
		expect(result.resolvedKnowledge).toBeUndefined();
	});

	test("vars with special regex characters are handled safely", () => {
		const config = minimalConfig({
			identity: { vars: { pattern: "foo.bar$baz" } },
		});
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				persona: "Pattern is {{pattern}}",
			},
		});
		expect(result.resolvedPersona).toBe("Pattern is foo.bar$baz");
	});

	test("multiple occurrences of same var are all replaced", () => {
		const config = minimalConfig({
			identity: { vars: { x: "42" } },
		});
		const result = compileOpenCodeConfig(config, {
			...defaultOptions(),
			resolvedIdentity: {
				persona: "{{x}} plus {{x}} equals double {{x}}",
			},
		});
		expect(result.resolvedPersona).toBe("42 plus 42 equals double 42");
	});
});

// ---- Step 10: Tool permission derivation ----

describe("tool permission derivation from capabilities", () => {
	test("'video' capability produces video_* permission", () => {
		const config = minimalConfig({ capabilities: ["video"] });
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.tools["video_*"]).toBe(true);
	});

	test("'image-gen' capability produces image-gen_* permission", () => {
		const config = minimalConfig({ capabilities: ["image-gen"] });
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.tools["image-gen_*"]).toBe(true);
	});

	test("both video and image-gen capabilities produce both permissions", () => {
		const config = minimalConfig({ capabilities: ["video", "image-gen"] });
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.tools["video_*"]).toBe(true);
		expect(result.config.tools["image-gen_*"]).toBe(true);
		expect(Object.keys(result.config.tools)).toHaveLength(2);
	});

	test("'search' capability does NOT produce tool permissions", () => {
		const config = minimalConfig({ capabilities: ["search"] });
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.tools["search_*"]).toBeUndefined();
		expect(result.config.tools["tavily_*"]).toBeUndefined();
		expect(Object.keys(result.config.tools)).toHaveLength(0);
	});

	test("no capabilities produces empty tools section", () => {
		const config = minimalConfig({ capabilities: [] });
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(Object.keys(result.config.tools)).toHaveLength(0);
	});

	test("tool named 'video' in tools array produces video_* permission", () => {
		const config = minimalConfig({
			capabilities: [],
			tools: [{ name: "video", binary: "vid", platforms: ["darwin"] }],
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.tools["video_*"]).toBe(true);
	});

	test("tool named 'image-gen' in tools array produces image-gen_* permission", () => {
		const config = minimalConfig({
			capabilities: [],
			tools: [{ name: "image-gen", binary: "ig", platforms: ["darwin"] }],
		});
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.tools["image-gen_*"]).toBe(true);
	});

	test("unrecognized capability does not produce tool permissions", () => {
		const config = minimalConfig({ capabilities: ["custom-thing"] });
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(Object.keys(result.config.tools)).toHaveLength(0);
	});
});

// ---- Step 10: JSON serialization and base template preservation ----

describe("output integrity", () => {
	test("compileOpenCodeConfig returns JSON-serializable object", () => {
		const config = minimalConfig({
			capabilities: ["search", "video", "image-gen"],
			memory: { store: "meilisearch", url: "http://localhost:7700" },
			heartbeat: { enabled: true },
			gateway: { channels: [{ type: "http", port: 7600, auth: "tok" }] },
		});
		const result = compileOpenCodeConfig(config, defaultOptions());

		// Must not throw
		const json = JSON.stringify(result.config);
		expect(json).toBeDefined();

		// Round-trip must preserve structure
		const parsed = JSON.parse(json);
		expect(parsed.$schema).toBe(result.config.$schema);
		expect(parsed.plugin).toEqual(result.config.plugin);
		expect(Object.keys(parsed.mcp).sort()).toEqual(Object.keys(result.config.mcp).sort());
		expect(Object.keys(parsed.tools).sort()).toEqual(Object.keys(result.config.tools).sort());
	});

	test("no circular references in output", () => {
		const config = minimalConfig({ capabilities: ["video"] });
		const result = compileOpenCodeConfig(config, defaultOptions());
		// JSON.stringify will throw on circular references
		expect(() => JSON.stringify(result.config)).not.toThrow();
		expect(() => JSON.stringify(result)).not.toThrow();
	});

	test("opencode.base.json fields are preserved — $schema", () => {
		const config = minimalConfig();
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.$schema).toBe("https://opencode.ai/config.json");
	});

	test("opencode.base.json fields are preserved — plugin list", () => {
		const config = minimalConfig();
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.plugin).toEqual(["opencode-claude-auth"]);
	});

	test("opencode.base.json fields are preserved — agent build disabled", () => {
		const config = minimalConfig();
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.agent.build.disable).toBe(true);
	});

	test("opencode.base.json fields are preserved — agent plan disabled", () => {
		const config = minimalConfig();
		const result = compileOpenCodeConfig(config, defaultOptions());
		expect(result.config.agent.plan.disable).toBe(true);
	});

	test("base template is not mutated between calls", () => {
		const config1 = minimalConfig({ capabilities: ["video", "image-gen"] });
		const result1 = compileOpenCodeConfig(config1, defaultOptions());

		const config2 = minimalConfig({ capabilities: [] });
		const result2 = compileOpenCodeConfig(config2, defaultOptions());

		// result1 should have video/image-gen, result2 should not
		expect(Object.keys(result1.config.mcp)).toContain("video");
		expect(Object.keys(result2.config.mcp)).not.toContain("video");

		// Both should still have base template fields
		expect(result1.config.$schema).toBe("https://opencode.ai/config.json");
		expect(result2.config.$schema).toBe("https://opencode.ai/config.json");
	});
});
