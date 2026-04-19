import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceSessionAccess, parseConfig, serializeVoiceSessionAccess } from "@randal/core";
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
			`bun -e 'const out = process.argv[1]; Bun.write(out, JSON.stringify({ trigger: process.env.RANDAL_TRIGGER || "", cronName: process.env.RANDAL_CRON_NAME || "", heartbeatTick: process.env.RANDAL_HEARTBEAT_TICK || "", jobId: process.env.RANDAL_JOB_ID || "", voiceAccess: process.env.RANDAL_VOICE_ACCESS || "", sessionAccessClass: process.env.RANDAL_SESSION_ACCESS_CLASS || "", sessionGrants: process.env.RANDAL_SESSION_ALLOWED_GRANTS || "", tavily: process.env.TAVILY_API_KEY || "" }));' "${outputFile}"`,
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
				triggerType: "heartbeat",
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
				triggerType: "cron",
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
				triggerType: "hook",
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
				triggerType: "heartbeat",
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

	test("voice metadata env vars are passed through for admin sessions", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);
		const access = createVoiceSessionAccess({
			accessClass: "admin",
			source: { transport: "phone", direction: "inbound", trustedCaller: true },
		});

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: { channel: "voice", replyTo: "session-1", from: "+15551111111" },
			metadata: { RANDAL_VOICE_ACCESS: serializeVoiceSessionAccess(access) },
		});

		expect(job.status).toBe("complete");
		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.sessionAccessClass).toBe("admin");
		expect(envData.sessionGrants).toBe("");
		expect(envData.voiceAccess).toContain('"accessClass":"admin"');
	});

	test("external voice sessions scrub ungranted search credentials", async () => {
		const originalTavilyKey = process.env.TAVILY_API_KEY;
		process.env.TAVILY_API_KEY = "test-tavily-key";

		try {
			const workdir = makeTmpDir();
			const config = makeConfig(workdir);
			const outputPath = join(workdir, "env-output.json");
			const scriptPath = makeEnvDumpScript(workdir, outputPath);
			const access = createVoiceSessionAccess({
				accessClass: "external",
				grants: ["memory"],
				source: { transport: "phone", direction: "outbound" },
			});

			const runner = new Runner({ config });
			const job = await runner.execute({
				prompt: scriptPath,
				origin: { channel: "voice", replyTo: "session-2", from: "+15552222222" },
				metadata: { RANDAL_VOICE_ACCESS: serializeVoiceSessionAccess(access) },
			});

			expect(job.status).toBe("complete");
			const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
			expect(envData.sessionAccessClass).toBe("external");
			expect(envData.sessionGrants).toBe("memory");
			expect(envData.tavily).toBe("");
		} finally {
			if (originalTavilyKey === undefined) {
				delete process.env.TAVILY_API_KEY;
			} else {
				process.env.TAVILY_API_KEY = originalTavilyKey;
			}
		}
	});

	test("voice-originated jobs fail closed when voice access metadata is missing", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: { channel: "voice", replyTo: "session-3", from: "+15553333333" },
		});

		expect(job.status).toBe("failed");
		expect(job.error).toContain("Voice session access metadata is missing or invalid");
		expect(existsSync(outputPath)).toBe(false);
	});

	test("voice-originated jobs fail closed when voice access metadata is malformed", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: { channel: "voice", replyTo: "session-4", from: "+15554444444" },
			metadata: { RANDAL_VOICE_ACCESS: "{not-json" },
		});

		expect(job.status).toBe("failed");
		expect(job.error).toContain("Voice session access metadata is missing or invalid");
		expect(existsSync(outputPath)).toBe(false);
	});

	test("voice-originated jobs fail closed when voice access metadata is semantically invalid", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeEnvDumpScript(workdir, outputPath);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: { channel: "voice", replyTo: "session-5", from: "+15555555555" },
			metadata: {
				RANDAL_VOICE_ACCESS:
					'{"version":1,"accessClass":"admin","capabilities":{"defaultPolicy":"deny","grants":[]},"source":{"transport":"invalid","direction":"inbound"}}',
			},
		});

		expect(job.status).toBe("failed");
		expect(job.error).toContain("Voice session access metadata is missing or invalid");
		expect(existsSync(outputPath)).toBe(false);
	});
});
