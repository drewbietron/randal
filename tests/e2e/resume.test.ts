import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import { Runner } from "@randal/runner";

describe("resume E2E", () => {
	test("failed job can be resumed with new runner", async () => {
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
		// Script that never completes
		const failScript = join(workdir, "fail.sh");
		writeFileSync(failScript, '#!/bin/bash\necho "Working but not done"\n', { mode: 0o755 });

		const runner1 = new Runner({ config });
		const failedJob = await runner1.execute({ prompt: failScript });
		expect(failedJob.status).toBe("failed");

		// Now create a script that completes
		const successScript = join(workdir, "success.sh");
		writeFileSync(successScript, '#!/bin/bash\necho "<promise>DONE</promise>"\n', { mode: 0o755 });

		// Resume by creating a new job with context from the failed one
		const resumePrompt = successScript;
		const runner2 = new Runner({ config });
		const resumedJob = await runner2.execute({ prompt: resumePrompt });
		expect(resumedJob.status).toBe("complete");
	});
});
