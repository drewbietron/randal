import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDiagnostics } from "./doctor.js";
import { executeSetup } from "./setup.js";

// ---- Test helpers ----

/** Create a unique temp directory for each test. */
function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `randal-doctor-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

describe("randal doctor — check results", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir("doctor");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("reports failure when opencode.json is missing", async () => {
		const configPath = writeTestConfig(tempDir, `
name: missing-json-test
runner:
  workdir: ${tempDir}
`);

		const outputDir = join(tempDir, "empty-output");
		mkdirSync(outputDir, { recursive: true });

		const result = await runDiagnostics({
			configPath,
			outputDir,
		});

		// Should have a failing check for opencode.json existence
		const jsonCheck = result.checks.find((c) => c.name === "opencode.json");
		expect(jsonCheck).toBeDefined();
		expect(jsonCheck?.status).toBe("fail");
		expect(result.failed).toBeGreaterThanOrEqual(1);
	});

	test("config check passes with valid config", async () => {
		const configPath = writeTestConfig(tempDir, `
name: valid-config-test
runner:
  workdir: ${tempDir}
`);

		const result = await runDiagnostics({
			configPath,
			outputDir: join(tempDir, "out"),
		});

		const configCheck = result.checks.find((c) => c.name === "Config");
		expect(configCheck).toBeDefined();
		expect(configCheck?.status).toBe("pass");
	});

	test("opencode.json check passes after setup", async () => {
		const configPath = writeTestConfig(tempDir, `
name: after-setup-test
runner:
  workdir: ${tempDir}
capabilities: [search]
`);

		const outputDir = join(tempDir, "setup-output");

		// Run setup first to create opencode.json
		await executeSetup({ configPath, outputDir });

		const result = await runDiagnostics({
			configPath,
			outputDir,
		});

		const jsonCheck = result.checks.find((c) => c.name === "opencode.json");
		expect(jsonCheck).toBeDefined();
		expect(jsonCheck?.status).toBe("pass");
	});

	test("stale detection warns when config changes after setup", async () => {
		const outputDir = join(tempDir, "stale-output");

		// Setup with search capability
		const configPath1 = writeTestConfig(tempDir, `
name: stale-test
runner:
  workdir: ${tempDir}
capabilities: [search]
`);
		await executeSetup({ configPath: configPath1, outputDir });

		// Now change config to add video capability
		const configPath2 = writeTestConfig(tempDir, `
name: stale-test
runner:
  workdir: ${tempDir}
capabilities: [search, video]
`);

		const result = await runDiagnostics({
			configPath: configPath2,
			outputDir,
		});

		const freshnessCheck = result.checks.find((c) => c.name === "Config freshness");
		expect(freshnessCheck).toBeDefined();
		// MCP servers differ (video added), so should warn
		expect(freshnessCheck?.status).toBe("warn");
	});

	test("stale detection passes when config matches on-disk", async () => {
		const configPath = writeTestConfig(tempDir, `
name: fresh-test
runner:
  workdir: ${tempDir}
capabilities: [search, video]
`);

		const outputDir = join(tempDir, "fresh-output");
		await executeSetup({ configPath, outputDir });

		const result = await runDiagnostics({
			configPath,
			outputDir,
		});

		const freshnessCheck = result.checks.find((c) => c.name === "Config freshness");
		expect(freshnessCheck).toBeDefined();
		expect(freshnessCheck?.status).toBe("pass");
	});

	test("reports failure for invalid opencode.json content", async () => {
		const configPath = writeTestConfig(tempDir, `
name: bad-json-test
runner:
  workdir: ${tempDir}
`);

		const outputDir = join(tempDir, "bad-json-output");
		mkdirSync(outputDir, { recursive: true });

		// Write invalid JSON
		writeFileSync(join(outputDir, "opencode.json"), "{ invalid json }", "utf-8");

		const result = await runDiagnostics({
			configPath,
			outputDir,
		});

		// Config freshness check should fail on invalid JSON
		const freshnessCheck = result.checks.find((c) => c.name === "Config freshness");
		expect(freshnessCheck).toBeDefined();
		expect(freshnessCheck?.status).toBe("fail");
	});

	test("result contains pass/warn/fail counts", async () => {
		const configPath = writeTestConfig(tempDir, `
name: counts-test
runner:
  workdir: ${tempDir}
`);

		const result = await runDiagnostics({
			configPath,
			outputDir: join(tempDir, "counts-output"),
		});

		expect(typeof result.passed).toBe("number");
		expect(typeof result.warned).toBe("number");
		expect(typeof result.failed).toBe("number");
		expect(result.passed + result.warned + result.failed).toBe(result.checks.length);
	});

	test("all checks have name, status, and message", async () => {
		const configPath = writeTestConfig(tempDir, `
name: shape-test
runner:
  workdir: ${tempDir}
`);

		const result = await runDiagnostics({
			configPath,
			outputDir: join(tempDir, "shape-output"),
		});

		for (const check of result.checks) {
			expect(check.name).toBeDefined();
			expect(typeof check.name).toBe("string");
			expect(check.name.length).toBeGreaterThan(0);

			expect(check.status).toBeDefined();
			expect(["pass", "fail", "warn"]).toContain(check.status);

			expect(check.message).toBeDefined();
			expect(typeof check.message).toBe("string");
			expect(check.message.length).toBeGreaterThan(0);
		}
	});
});

describe("randal doctor — module exports", () => {
	test("exports doctorCommand function", async () => {
		const mod = await import("./doctor.js");
		expect(typeof mod.doctorCommand).toBe("function");
	});

	test("exports runDiagnostics function", async () => {
		const mod = await import("./doctor.js");
		expect(typeof mod.runDiagnostics).toBe("function");
	});
});
