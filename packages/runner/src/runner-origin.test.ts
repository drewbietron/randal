import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import { Runner } from "./runner.js";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "randal-runner-origin-test-"));
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

function makeScript(workdir: string, name: string, outputPath: string, fields: string[]): string {
	const scriptPath = join(workdir, name);
	const pairs = fields.map((f) => `\\"${f}\\":\\"$RANDAL_${f.toUpperCase()}\\"`).join(",");
	writeFileSync(
		scriptPath,
		`#!/bin/bash\necho "{${pairs}}" > "${outputPath}"\necho "<promise>DONE</promise>"\n`,
		{ mode: 0o755 },
	);
	return scriptPath;
}

describe("Runner — channel awareness origin env vars", () => {
	test("passes origin env vars to brain process", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output.json");
		const scriptPath = makeScript(workdir, "env-dump.sh", outputPath, [
			"channel",
			"from",
			"reply_to",
			"job_id",
		]);

		const runner = new Runner({ config });
		const job = await runner.execute({
			prompt: scriptPath,
			origin: { channel: "discord", from: "user-123", replyTo: "thread-456" },
		});

		expect(job.status).toBe("complete");
		expect(existsSync(outputPath)).toBe(true);

		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.channel).toBe("discord");
		expect(envData.from).toBe("user-123");
		expect(envData.reply_to).toBe("thread-456");
		expect(envData.job_id).toBeTruthy();
	});

	test("omits origin env vars when no origin (interactive mode)", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const outputPath = join(workdir, "env-output2.json");
		const scriptPath = makeScript(workdir, "env-dump2.sh", outputPath, [
			"channel",
			"from",
			"reply_to",
		]);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");
		const envData = JSON.parse(readFileSync(outputPath, "utf-8"));
		expect(envData.channel).toBe("");
		expect(envData.from).toBe("");
		expect(envData.reply_to).toBe("");
	});
});
