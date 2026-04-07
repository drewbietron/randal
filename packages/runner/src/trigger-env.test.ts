import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import { Runner } from "./runner.js";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "randal-trigger-test-"));
}

function makeConfig(workdir: string) {
	return parseConfig(`
name: test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  defaultMaxIterations: 5
  completionPromise: DONE
  struggle:
    noChangeThreshold: 3
    maxRepeatedErrors: 3
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);
}

/**
 * Create a shell script that dumps trigger-related env vars to a JSON file.
 */
function makeEnvDumpScript(workdir: string, outputFile: string): string {
	const scriptPath = join(workdir, "env-dump.sh");
	writeFileSync(
		scriptPath,
		[
			"#!/bin/bash",
			`echo '{"trigger":"'"\$RANDAL_TRIGGER"'","cronName":"'"\$RANDAL_CRON_NAME"'","heartbeatTick":"'"\$RANDAL_HEARTBEAT_TICK"'","jobId":"'"\$RANDAL_JOB_ID"'"}' > "${outputFile}"`,
			'echo "<promise>DONE</promise>"',
		].join("\n"),
		{ mode: 0o755 },
	);
	return scriptPath;
}

describe("Trigger env vars", () => {
	test("heartbeat origin sets RANDAL_TRIGGER=heartbeat", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: {
				channel: "scheduler",
				replyTo: "heartbeat",
				from: "system",
			},
		});

		expect(job.status).toBe("complete");
		expect(existsSync(outputPath)).toBe(true);

		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.trigger).toBe("heartbeat");
	});

	test("cron origin sets RANDAL_TRIGGER=cron and RANDAL_CRON_NAME", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: {
				channel: "scheduler",
				replyTo: "cron:daily-review",
				from: "system",
			},
		});

		expect(job.status).toBe("complete");
		expect(existsSync(outputPath)).toBe(true);

		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.trigger).toBe("cron");
		expect(envData.cronName).toBe("daily-review");
	});

	test("hook origin sets RANDAL_TRIGGER=hook", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: {
				channel: "scheduler",
				replyTo: "hook:agent",
				from: "system",
			},
		});

		expect(job.status).toBe("complete");
		expect(existsSync(outputPath)).toBe(true);

		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.trigger).toBe("hook");
	});

	test("no origin sets RANDAL_TRIGGER=user", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
		});

		expect(job.status).toBe("complete");
		expect(existsSync(outputPath)).toBe(true);

		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.trigger).toBe("user");
	});

	test("metadata env vars are passed through (RANDAL_HEARTBEAT_TICK)", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: {
				channel: "scheduler",
				replyTo: "heartbeat",
				from: "system",
			},
			metadata: { RANDAL_HEARTBEAT_TICK: "42" },
		});

		expect(job.status).toBe("complete");
		expect(existsSync(outputPath)).toBe(true);

		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.trigger).toBe("heartbeat");
		expect(envData.heartbeatTick).toBe("42");
	});

	test("non-scheduler origin sets RANDAL_TRIGGER=user", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: {
				channel: "discord",
				replyTo: "thread-123",
				from: "user-456",
			},
		});

		expect(job.status).toBe("complete");
		expect(existsSync(outputPath)).toBe(true);

		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.trigger).toBe("user");
	});
});
