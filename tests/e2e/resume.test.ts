import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import { Runner } from "@randal/runner";

describe("resume E2E", () => {
	test("resumes a failed job with the same prompt and workdir", async () => {
		const workdir = mkdtempSync(join(tmpdir(), "randal-resume-"));
		const config = parseConfig(`
name: test-resume
runner:
  workdir: ${workdir}
  defaultAgent: mock
  defaultMaxIterations: 1
  completionPromise: DONE
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		// Script that never outputs the promise
		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(scriptPath, '#!/bin/bash\necho "Modified src/task.ts"\n', { mode: 0o755 });

		// 1. Run a job that fails (max iterations reached without promise)
		const runner = new Runner({ config });
		const failedJob = await runner.execute({ prompt: scriptPath });
		expect(failedJob.status).toBe("failed");

		// 2. Update the script to succeed for the resume
		writeFileSync(scriptPath, '#!/bin/bash\necho "<promise>DONE</promise>"\n', {
			mode: 0o755,
		});

		// 3. Resume by re-executing with the same prompt/workdir/agent
		const resumedJob = await runner.execute({
			prompt: failedJob.prompt,
			workdir: failedJob.workdir,
			agent: failedJob.agent,
		});

		// 4. Verify the resumed job uses the same workdir and prompt
		expect(resumedJob.status).toBe("complete");
		expect(resumedJob.workdir).toBe(failedJob.workdir);
		expect(resumedJob.prompt).toBe(failedJob.prompt);
		expect(resumedJob.id).not.toBe(failedJob.id); // New job ID
	});
});
