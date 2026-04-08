import { describe, expect, test } from "bun:test";
import { configSchema } from "./config.js";
import { compileOpenCodeConfig } from "./config-compile.js";
import type { RandalConfig, CompileOptions } from "./index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// ---- Backward compatibility ----

describe("backward compatibility — default config produces equivalent output", () => {
	/**
	 * Construct a config that mimics the current production setup:
	 *   - memory.store = meilisearch (at localhost:7701)
	 *   - heartbeat enabled
	 *   - capabilities: search, video, image-gen
	 *
	 * This should produce an opencode.json with the same MCP servers,
	 * tool permissions, plugins, and agent config as the hand-crafted
	 * agent/opencode-config/opencode.json.
	 */
	const productionLikeConfig = configSchema.parse({
		name: "randal",
		runner: { workdir: "/Users/drewbie/dev/randal" },
		memory: {
			store: "meilisearch",
			url: "http://localhost:7701",
		},
		heartbeat: { enabled: true },
		gateway: {
			channels: [{ type: "http", port: 7600, auth: "test-token" }],
		},
		capabilities: ["search", "video", "image-gen"],
	}) as RandalConfig;

	const repoRoot = resolve(import.meta.dir, "../../..");
	const handCraftedPath = resolve(repoRoot, "agent/opencode-config/opencode.json");

	let handCrafted: Record<string, unknown>;
	try {
		handCrafted = JSON.parse(readFileSync(handCraftedPath, "utf-8"));
	} catch {
		// If the file doesn't exist in CI or test environments, skip structural comparison
		handCrafted = {};
	}

	const compiled = compileOpenCodeConfig(productionLikeConfig, {
		basePath: "/Users/drewbie/dev/randal",
		repoRoot,
		toolsDir: resolve(repoRoot, "tools"),
	});

	test("produces same $schema", () => {
		expect(compiled.config.$schema).toBe("https://opencode.ai/config.json");
		if (handCrafted.$schema) {
			expect(compiled.config.$schema).toBe(handCrafted.$schema);
		}
	});

	test("produces same plugin list", () => {
		expect(compiled.config.plugin).toEqual(["opencode-claude-auth"]);
		if (handCrafted.plugin) {
			expect(compiled.config.plugin).toEqual(handCrafted.plugin);
		}
	});

	test("produces same agent config (plan/build disabled)", () => {
		expect(compiled.config.agent.build.disable).toBe(true);
		expect(compiled.config.agent.plan.disable).toBe(true);
		if (handCrafted.agent) {
			const hcAgent = handCrafted.agent as Record<string, unknown>;
			expect(compiled.config.agent).toEqual(hcAgent);
		}
	});

	test("produces same set of MCP server names", () => {
		const compiledKeys = Object.keys(compiled.config.mcp).sort();
		// The production config should have: memory, scheduler, tavily, video, image-gen
		expect(compiledKeys).toContain("memory");
		expect(compiledKeys).toContain("scheduler");
		expect(compiledKeys).toContain("tavily");
		expect(compiledKeys).toContain("video");
		expect(compiledKeys).toContain("image-gen");

		if (handCrafted.mcp) {
			const hcKeys = Object.keys(handCrafted.mcp as Record<string, unknown>).sort();
			expect(compiledKeys).toEqual(hcKeys);
		}
	});

	test("tavily MCP uses same remote URL pattern", () => {
		const tavily = compiled.config.mcp.tavily;
		expect(tavily.type).toBe("remote");
		expect(tavily.url).toBe("https://mcp.tavily.com/mcp/?tavilyApiKey={env:TAVILY_API_KEY}");
	});

	test("memory MCP is local with correct environment", () => {
		const memory = compiled.config.mcp.memory;
		expect(memory.type).toBe("local");
		expect(memory.command).toBeDefined();
		const memoryCmd = memory.command ?? [];
		expect(memoryCmd[0]).toBe("bun");
		expect(memoryCmd[1]).toBe("run");
		expect(memoryCmd[2]).toContain("mcp-memory-server.ts");
		expect(memory.environment?.MEILI_URL).toBe("http://localhost:7701");
		expect(memory.environment?.SUMMARY_MODEL).toBeDefined();
	});

	test("scheduler MCP is local with gateway environment", () => {
		const scheduler = compiled.config.mcp.scheduler;
		expect(scheduler.type).toBe("local");
		expect(scheduler.command).toBeDefined();
		const schedulerCmd = scheduler.command ?? [];
		expect(schedulerCmd[2]).toContain("mcp-scheduler-server.ts");
		expect(scheduler.environment?.RANDAL_GATEWAY_URL).toBeDefined();
		expect(scheduler.environment?.RANDAL_GATEWAY_TOKEN).toBe("{env:RANDAL_GATEWAY_TOKEN}");
	});

	test("video MCP is local", () => {
		const video = compiled.config.mcp.video;
		expect(video.type).toBe("local");
		const videoCmd = video.command ?? [];
		expect(videoCmd[2]).toContain("video/mcp-server.ts");
	});

	test("image-gen MCP is local", () => {
		const imageGen = compiled.config.mcp["image-gen"];
		expect(imageGen.type).toBe("local");
		const imageGenCmd = imageGen.command ?? [];
		expect(imageGenCmd[2]).toContain("image-gen/mcp-server.ts");
	});

	test("produces same tool permissions", () => {
		expect(compiled.config.tools["video_*"]).toBe(true);
		expect(compiled.config.tools["image-gen_*"]).toBe(true);

		if (handCrafted.tools) {
			const hcTools = handCrafted.tools as Record<string, boolean>;
			expect(Object.keys(compiled.config.tools).sort()).toEqual(
				Object.keys(hcTools).sort(),
			);
		}
	});

	test("uses dynamic paths, not hardcoded absolute paths", () => {
		// The compiled config should use toolsDir-based paths, not hardcoded user paths
		for (const [_name, entry] of Object.entries(compiled.config.mcp)) {
			if (entry.command) {
				for (const part of entry.command) {
					// Paths should be based on the repo root we provided, not some other hardcoded path
					if (part.includes("/tools/")) {
						expect(part.startsWith(resolve(repoRoot, "tools"))).toBe(true);
					}
				}
			}
		}
	});
});

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
		expect(Object.keys(deserialized.mcp).sort()).toEqual(
			Object.keys(result.config.mcp).sort(),
		);
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
		expect(videoCmd[2]).toBe(
			"/my/workspace/tools/video/mcp-server.ts",
		);
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
