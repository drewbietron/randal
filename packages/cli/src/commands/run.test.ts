import { describe, expect, test } from "bun:test";
import { parseRunArgs } from "./run.js";

describe("run command", () => {
	test("module exports runCommand function", async () => {
		const mod = await import("./run.js");
		expect(typeof mod.runCommand).toBe("function");
	});
});

describe("parseRunArgs", () => {
	test("parses --agent flag correctly", () => {
		const result = parseRunArgs(["fix the bug", "--agent", "opencode"]);
		expect(result.agent).toBe("opencode");
		expect(result.prompt).toBe("fix the bug");
	});

	test("parses --max-iterations as number", () => {
		const result = parseRunArgs(["do something", "--max-iterations", "10"]);
		expect(result.maxIterations).toBe(10);
	});

	test("treats non-flag args as prompt text", () => {
		const result = parseRunArgs(["refactor the auth module"]);
		expect(result.prompt).toBe("refactor the auth module");
	});

	test("handles --verbose flag", () => {
		const result = parseRunArgs(["test prompt", "--verbose"]);
		expect(result.verbose).toBe(true);
	});

	test("handles -v flag", () => {
		const result = parseRunArgs(["test prompt", "-v"]);
		expect(result.verbose).toBe(true);
	});

	test("handles --no-memory without eating next arg", () => {
		const result = parseRunArgs(["--no-memory", "my prompt here"]);
		expect(result.prompt).toBe("my prompt here");
	});

	test("handles --workdir flag", () => {
		const result = parseRunArgs(["test prompt", "--workdir", "/tmp/test"]);
		expect(result.workdir).toBe("/tmp/test");
	});

	test("handles --model flag", () => {
		const result = parseRunArgs(["test prompt", "--model", "claude-3-opus"]);
		expect(result.model).toBe("claude-3-opus");
	});

	test("skips --config value arg", () => {
		const result = parseRunArgs(["--config", "custom.yaml", "my prompt"]);
		expect(result.prompt).toBe("my prompt");
	});

	test("returns undefined prompt when no prompt given", () => {
		const result = parseRunArgs(["--verbose"]);
		expect(result.prompt).toBeUndefined();
	});

	test("handles multiple flags together", () => {
		const result = parseRunArgs([
			"fix everything",
			"--agent",
			"opencode",
			"--max-iterations",
			"5",
			"--verbose",
		]);
		expect(result.prompt).toBe("fix everything");
		expect(result.agent).toBe("opencode");
		expect(result.maxIterations).toBe(5);
		expect(result.verbose).toBe(true);
	});
});
