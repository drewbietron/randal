import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodeConfig } from "@randal/core";
import { executeSetup } from "./setup.js";

// ---- Test helpers ----

/** Create a unique temp directory for each test. */
function makeTempDir(prefix: string): string {
	const dir = join(
		tmpdir(),
		`randal-setup-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Write a minimal randal.config.yaml to a directory. */
function writeTestConfig(dir: string, yaml: string): string {
	const configPath = join(dir, "randal.config.yaml");
	writeFileSync(configPath, yaml, "utf-8");
	return configPath;
}

// ---- Tests ----

describe("randal setup — dry-run", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir("dryrun");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("dry-run returns compiled config without writing files", async () => {
		const configPath = writeTestConfig(
			tempDir,
			`
name: test-setup-agent
runner:
  workdir: ${tempDir}
capabilities: [search, video]
`,
		);

		const outputDir = join(tempDir, "output");

		const result = await executeSetup({
			configPath,
			outputDir,
			dryRun: true,
		});

		// Should return a valid compile result
		expect(result.compileResult).toBeDefined();
		expect(result.compileResult.config).toBeDefined();
		expect(result.compileResult.config.$schema).toBe("https://opencode.ai/config.json");

		// Should NOT write any files
		expect(existsSync(join(outputDir, "opencode.json"))).toBe(false);
	});

	test("dry-run output contains expected MCP servers based on config", async () => {
		const configPath = writeTestConfig(
			tempDir,
			`
name: test-mcp-agent
runner:
  workdir: ${tempDir}
capabilities: [search, video, image-gen]
heartbeat:
  enabled: true
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
`,
		);

		const result = await executeSetup({
			configPath,
			outputDir: join(tempDir, "out"),
			dryRun: true,
		});

		const config = result.compileResult.config;
		const mcpNames = Object.keys(config.mcp);

		// Memory is always present (defaults to meilisearch)
		expect(mcpNames).toContain("memory");
		// Heartbeat enabled → scheduler present
		expect(mcpNames).toContain("scheduler");
		// search capability → tavily present
		expect(mcpNames).toContain("tavily");
		// video capability → video present
		expect(mcpNames).toContain("video");
		// image-gen capability → image-gen present
		expect(mcpNames).toContain("image-gen");
	});

	test("dry-run output is valid JSON-serializable", async () => {
		const configPath = writeTestConfig(
			tempDir,
			`
name: json-test
runner:
  workdir: ${tempDir}
capabilities: [search]
`,
		);

		const result = await executeSetup({
			configPath,
			outputDir: join(tempDir, "out"),
			dryRun: true,
		});

		// Should round-trip through JSON without error
		const serialized = JSON.stringify(result.compileResult.config, null, "\t");
		const parsed = JSON.parse(serialized) as OpenCodeConfig;
		expect(parsed.$schema).toBe("https://opencode.ai/config.json");
		expect(parsed.plugin).toEqual(["opencode-claude-auth"]);
		expect(parsed.agent.build.disable).toBe(true);
		expect(parsed.agent.plan.disable).toBe(true);
	});

	test("dry-run returns symlink list (may be empty if source dir not found)", async () => {
		const configPath = writeTestConfig(
			tempDir,
			`
name: symlink-test
runner:
  workdir: ${tempDir}
`,
		);

		const result = await executeSetup({
			configPath,
			outputDir: join(tempDir, "out"),
			dryRun: true,
		});

		// Symlinks array should be defined (may be empty if agent/opencode-config not found)
		expect(Array.isArray(result.symlinks)).toBe(true);
		// If symlinks were found, they should all target the output directory
		for (const link of result.symlinks) {
			expect(link.target.startsWith(join(tempDir, "out"))).toBe(true);
			expect(typeof link.source).toBe("string");
		}
	});
});

describe("randal setup — file generation", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir("gen");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("writes opencode.json to output directory", async () => {
		const configPath = writeTestConfig(
			tempDir,
			`
name: write-test
runner:
  workdir: ${tempDir}
capabilities: [search]
`,
		);

		const outputDir = join(tempDir, "output");

		const result = await executeSetup({
			configPath,
			outputDir,
		});

		// opencode.json should exist
		const jsonPath = join(outputDir, "opencode.json");
		expect(existsSync(jsonPath)).toBe(true);
		expect(result.outputPath).toBe(jsonPath);

		// Should be valid JSON
		const content = readFileSync(jsonPath, "utf-8");
		const parsed = JSON.parse(content) as OpenCodeConfig;
		expect(parsed.$schema).toBe("https://opencode.ai/config.json");
		expect(parsed.mcp.tavily).toBeDefined();
	});

	test("generated opencode.json includes correct MCP servers", async () => {
		const configPath = writeTestConfig(
			tempDir,
			`
name: mcp-gen-test
runner:
  workdir: ${tempDir}
capabilities: [video, image-gen]
heartbeat:
  enabled: true
gateway:
  channels:
    - type: http
      port: 8080
      auth: token123
`,
		);

		const outputDir = join(tempDir, "output");
		await executeSetup({ configPath, outputDir });

		const jsonPath = join(outputDir, "opencode.json");
		const config = JSON.parse(readFileSync(jsonPath, "utf-8")) as OpenCodeConfig;

		expect(config.mcp.memory).toBeDefined();
		expect(config.mcp.scheduler).toBeDefined();
		expect(config.mcp.video).toBeDefined();
		expect(config.mcp["image-gen"]).toBeDefined();
		expect(config.tools["video_*"]).toBe(true);
		expect(config.tools["image-gen_*"]).toBe(true);
	});

	test("is idempotent — running twice does not corrupt output", async () => {
		const configPath = writeTestConfig(
			tempDir,
			`
name: idempotent-test
runner:
  workdir: ${tempDir}
capabilities: [search]
`,
		);

		const outputDir = join(tempDir, "output");

		// First run
		await executeSetup({ configPath, outputDir });
		const firstContent = readFileSync(join(outputDir, "opencode.json"), "utf-8");

		// Second run
		await executeSetup({ configPath, outputDir });
		const secondContent = readFileSync(join(outputDir, "opencode.json"), "utf-8");

		// Content should be identical
		expect(secondContent).toBe(firstContent);
	});

	test("creates output directory if it does not exist", async () => {
		const configPath = writeTestConfig(
			tempDir,
			`
name: mkdir-test
runner:
  workdir: ${tempDir}
`,
		);

		const outputDir = join(tempDir, "nested", "deep", "output");
		expect(existsSync(outputDir)).toBe(false);

		await executeSetup({ configPath, outputDir });

		expect(existsSync(outputDir)).toBe(true);
		expect(existsSync(join(outputDir, "opencode.json"))).toBe(true);
	});
});

describe("randal setup — module exports", () => {
	test("exports setupCommand function", async () => {
		const mod = await import("./setup.js");
		expect(typeof mod.setupCommand).toBe("function");
	});

	test("exports executeSetup function", async () => {
		const mod = await import("./setup.js");
		expect(typeof mod.executeSetup).toBe("function");
	});
});
