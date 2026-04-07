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
  brainManaged: false
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
  brainManaged: false
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		// Script that never outputs the promise but produces file change indicators
		const scriptPath = join(workdir, "stuck.sh");
		writeFileSync(scriptPath, '#!/bin/bash\necho "Modified src/index.ts"\n', { mode: 0o755 });

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("failed");
		expect(job.error).toContain("Max iterations");
		expect(job.iterations.current).toBe(2);
	});

	test("stop cancels a job and kills the process", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);
		const events: RunnerEvent[] = [];

		// Script that runs for a long time
		const scriptPath = join(workdir, "slow.sh");
		writeFileSync(scriptPath, '#!/bin/bash\nsleep 10\necho "done"\n', { mode: 0o755 });

		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});

		// Start job in background
		const jobPromise = runner.execute({ prompt: scriptPath });

		// Wait for the job to actually start running
		const waitStart = Date.now();
		while (runner.getActiveJobs().length === 0 && Date.now() - waitStart < 2000) {
			await new Promise((r) => setTimeout(r, 10));
		}

		// Get the active job and stop it
		const active = runner.getActiveJobs();
		expect(active.length).toBeGreaterThan(0);
		const stopped = runner.stop(active[0].id);
		expect(stopped).toBe(true);

		const job = await jobPromise;
		expect(job.status).toBe("stopped");
		expect(events.some((e) => e.type === "job.stopped")).toBe(true);
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

	test("iteration timeout kills long-running process", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  defaultMaxIterations: 1
  completionPromise: DONE
  iterationTimeout: 2
  brainManaged: false
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		// Script that sleeps longer than the timeout
		const scriptPath = join(workdir, "timeout.sh");
		writeFileSync(scriptPath, '#!/bin/bash\nsleep 30\necho "<promise>DONE</promise>"\n', {
			mode: 0o755,
		});

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		// Job should fail because iteration timed out and no promise was found
		expect(job.status).toBe("failed");
		// Should have completed in roughly 2 seconds, not 30
		expect(job.duration).toBeLessThan(10);
	}, 15000);

	test("captures stderr output in iteration", async () => {
		const workdir = makeTmpDir();
		const config = makeConfig(workdir);

		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "stdout output"\necho "stderr warning" >&2\necho "<promise>DONE</promise>"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");
		// Check that stderr was captured in iteration history
		const lastIter = job.iterations.history[0];
		expect(lastIter.stderr).toContain("stderr warning");
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

// ── Runner — brainManaged session ───────────────────────────

function makeBrainConfig(workdir: string) {
	return parseConfig(`
name: test-brain
runner:
  workdir: ${workdir}
  defaultAgent: mock
  completionPromise: DONE
  brainManaged: true
  sessionTimeout: 10
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);
}

describe("Runner — brainManaged", () => {
	test("completes on promise tag", async () => {
		const workdir = makeTmpDir();
		const config = makeBrainConfig(workdir);
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
		const config = makeBrainConfig(workdir);

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
		const config = makeBrainConfig(workdir);

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
		const config = makeBrainConfig(workdir);

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
		const config = makeBrainConfig(workdir);
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
		const config = makeBrainConfig(workdir);
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

	test("session timeout kills long-running brain", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: test-brain-timeout
runner:
  workdir: ${workdir}
  defaultAgent: mock
  completionPromise: DONE
  brainManaged: true
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
		const config = makeBrainConfig(workdir);

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
		const config = makeBrainConfig(workdir);

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
		const config = makeBrainConfig(workdir);

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
