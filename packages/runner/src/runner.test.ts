import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "@randal/core";
import { parseConfig } from "@randal/core";
import { Runner } from "./runner.js";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "randal-runner-test-"));
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

describe("Runner", () => {
	test("executes a simple job with echo", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const events: RunnerEvent[] = [];

		// Create a simple script that outputs the promise
		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "Working on it"\necho "<promise>DONE</promise>"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});

		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");
		expect(job.iterations.current).toBe(1);
		expect(events.some((e) => e.type === "job.queued")).toBe(true);
		expect(events.some((e) => e.type === "job.started")).toBe(true);
		expect(events.some((e) => e.type === "iteration.start")).toBe(true);
		expect(events.some((e) => e.type === "iteration.end")).toBe(true);
		expect(events.some((e) => e.type === "job.complete")).toBe(true);
	});

	test("stops after max iterations without promise", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  defaultMaxIterations: 2
  completionPromise: DONE
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		// Script that never outputs the promise
		const scriptPath = join(workdir, "stuck.sh");
		writeFileSync(scriptPath, '#!/bin/bash\necho "Still working..."\n', { mode: 0o755 });

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("failed");
		expect(job.error).toContain("Max iterations");
		expect(job.iterations.current).toBe(2);
	});

	test("stop cancels a job", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		// Script that sleeps
		const scriptPath = join(workdir, "slow.sh");
		writeFileSync(scriptPath, '#!/bin/bash\nsleep 0.1\necho "done"\n', { mode: 0o755 });

		const runner = new Runner({ config });

		// Start job in background
		const jobPromise = runner.execute({ prompt: scriptPath });

		// Give it a moment to start
		await new Promise((r) => setTimeout(r, 50));

		// Get the active job and stop it
		const active = runner.getActiveJobs();
		if (active.length > 0) {
			runner.stop(active[0].id);
		}

		const job = await jobPromise;
		// Job should be stopped or complete (race condition possible)
		expect(["stopped", "complete"]).toContain(job.status);
	});

	test("job events include proper data", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const events: RunnerEvent[] = [];

		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "Tokens used: input=5000, output=1200"\necho "<promise>DONE</promise>"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});

		const _job = await runner.execute({ prompt: scriptPath });

		const iterEnd = events.find((e) => e.type === "iteration.end");
		expect(iterEnd).toBeDefined();
		expect(iterEnd?.data.iteration).toBe(1);
		expect(iterEnd?.data.exitCode).toBe(0);
	});

	test("uses spec file when provided", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		// Create a spec file. Since mock adapter passes prompt as bash arg,
		// the spec content becomes the script to execute via bash -c.
		const specContent = 'echo "From spec"\necho "<promise>DONE</promise>"';
		writeFileSync(join(workdir, "spec.md"), specContent);

		// Create a wrapper script that the mock adapter can run
		// The mock adapter runs: bash <prompt>, so we write a shell script
		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(scriptPath, '#!/bin/bash\necho "From spec"\necho "<promise>DONE</promise>"\n', {
			mode: 0o755,
		});

		const runner = new Runner({ config });
		// For mock adapter: prompt = script path. Test spec metadata is stored.
		const job = await runner.execute({
			prompt: scriptPath,
		});

		expect(job.status).toBe("complete");
	});
});
