import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  sessionTimeout: 10
  struggle:
    noChangeThreshold: 3
    maxRepeatedErrors: 3
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);
}

describe("Runner", () => {
	test("completes on promise tag", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const events: RunnerEvent[] = [];

		const scriptPath = join(workdir, "brain.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "Planning..."\necho "<progress>Step 1 done</progress>"\necho "<promise>DONE</promise>"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});

		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");
		expect(events.some((e) => e.type === "job.queued")).toBe(true);
		expect(events.some((e) => e.type === "job.started")).toBe(true);
		expect(events.some((e) => e.type === "job.complete")).toBe(true);
	});

	test("fails on non-zero exit without promise", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		const scriptPath = join(workdir, "fail.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "Something went wrong"\nexit 1\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("failed");
	});

	test("completes on clean exit without promise", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		const scriptPath = join(workdir, "clean.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "All done, nothing more to do"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		// Clean exit (0) with output = complete (brain decided it was done)
		expect(job.status).toBe("complete");
	});

	test("fails on empty output even with exit code 0", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		// Script that produces no output (simulates binary not found / TUI mode)
		const scriptPath = join(workdir, "empty.sh");
		writeFileSync(scriptPath, "#!/bin/bash\n", { mode: 0o755 });

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("failed");
		expect(job.error).toContain("no output");
	});

	test("can be stopped mid-session", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const events: RunnerEvent[] = [];

		const scriptPath = join(workdir, "slow-brain.sh");
		writeFileSync(scriptPath, "#!/bin/bash\nsleep 30\n", { mode: 0o755 });

		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});

		const jobPromise = runner.execute({ prompt: scriptPath });

		// Wait for job to start
		const waitStart = Date.now();
		while (runner.getActiveJobs().length === 0 && Date.now() - waitStart < 2000) {
			await new Promise((r) => setTimeout(r, 10));
		}

		const active = runner.getActiveJobs();
		expect(active.length).toBeGreaterThan(0);
		runner.stop(active[0].id);

		const job = await jobPromise;
		expect(job.status).toBe("stopped");
	});

	test("emits progress events from stream tags", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const events: RunnerEvent[] = [];

		const scriptPath = join(workdir, "progress.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "<progress>Planning phase complete</progress>"\necho "<progress>Building step 1/3</progress>"\necho "<promise>DONE</promise>"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});

		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");
		const outputEvents = events.filter((e) => e.type === "iteration.output");
		expect(outputEvents.length).toBeGreaterThanOrEqual(1);
	});

	test("session timeout kills long-running session", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: test-timeout
runner:
  workdir: ${workdir}
  defaultAgent: mock
  completionPromise: DONE
  sessionTimeout: 2
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		const scriptPath = join(workdir, "slow.sh");
		writeFileSync(scriptPath, "#!/bin/bash\nsleep 30\n", { mode: 0o755 });

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("failed");
		expect(job.duration).toBeLessThan(10);
	}, 15000);

	test("detects fatal errors in brain session", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		const scriptPath = join(workdir, "fatal.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "Error: API key is invalid"\nexit 1\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("failed");
		expect(job.error).toContain("Fatal");
	});

	test("writes loop-state.json on completion", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		const scriptPath = join(workdir, "brain.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "<promise>DONE</promise>"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");

		// Verify loop-state.json was written
		const loopStatePath = join(workdir, ".opencode", "loop-state.json");
		expect(existsSync(loopStatePath)).toBe(true);

		const loopState = JSON.parse(readFileSync(loopStatePath, "utf-8"));
		expect(loopState.version).toBe(1);
		expect(loopState.builds[job.id]).toBeDefined();
		expect(loopState.builds[job.id].status).toBe("completed");
		expect(loopState.builds[job.id].jobId).toBe(job.id);
	});

	test("writes loop-state.json on failure", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		const scriptPath = join(workdir, "fail.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "Something broke"\nexit 1\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("failed");

		const loopStatePath = join(workdir, ".opencode", "loop-state.json");
		expect(existsSync(loopStatePath)).toBe(true);

		const loopState = JSON.parse(readFileSync(loopStatePath, "utf-8"));
		expect(loopState.builds[job.id].status).toBe("errored");
	});
});
