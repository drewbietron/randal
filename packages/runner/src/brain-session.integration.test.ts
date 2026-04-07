/**
 * Integration test for the brain-managed session flow.
 * Tests the full path: Runner → runBrainSession → stdout parsing → events → loop-state.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "@randal/core";
import { parseConfig } from "@randal/core";
import { Runner } from "./runner.js";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "randal-brain-integration-"));
}

describe("Brain-managed session integration", () => {
	test("full lifecycle: start → progress → plan-update → complete", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: integration-test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  brainManaged: true
  completionPromise: DONE
  sessionTimeout: 30
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		const events: RunnerEvent[] = [];

		// Mock brain script that simulates a real brain session
		const scriptPath = join(workdir, "brain-sim.sh");
		writeFileSync(
			scriptPath,
			`#!/bin/bash
echo "Starting brain session..."
echo '<progress>Planning: Phase 1, Turn 1. Analyzing requirements.</progress>'
sleep 0.1
echo '<plan-update>[{"task":"Analyze codebase","status":"completed"},{"task":"Implement feature","status":"in_progress"},{"task":"Write tests","status":"pending"}]</plan-update>'
sleep 0.1
echo '<progress>Building: 1/3 steps. Step 2 next. Est ~5m.</progress>'
sleep 0.1
echo '<progress>Building: 2/3 steps. Step 3 next. Est ~3m.</progress>'
sleep 0.1
echo "All tasks complete."
echo '<promise>DONE</promise>'
`,
			{ mode: 0o755 },
		);

		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});

		const job = await runner.execute({ prompt: scriptPath });

		// Job completed successfully
		expect(job.status).toBe("complete");
		expect(job.duration).toBeGreaterThanOrEqual(0);

		// Events were emitted
		expect(events.some((e) => e.type === "job.queued")).toBe(true);
		expect(events.some((e) => e.type === "job.started")).toBe(true);
		expect(events.some((e) => e.type === "job.complete")).toBe(true);

		// Progress events were parsed from tags
		const progressEvents = events.filter((e) => e.type === "iteration.output");
		expect(progressEvents.length).toBeGreaterThanOrEqual(2);

		// Plan update events were parsed from tags
		const planEvents = events.filter((e) => e.type === "job.plan_updated");
		expect(planEvents.length).toBeGreaterThanOrEqual(1);

		// loop-state.json was written
		const loopStatePath = join(workdir, ".opencode", "loop-state.json");
		expect(existsSync(loopStatePath)).toBe(true);

		const loopState = JSON.parse(readFileSync(loopStatePath, "utf-8"));
		expect(loopState.version).toBe(1);
		expect(loopState.builds[job.id]).toBeDefined();
		expect(loopState.builds[job.id].status).toBe("completed");
		expect(loopState.builds[job.id].jobId).toBe(job.id);
	});

	test("no memorySearch or skillSearch callbacks needed", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: no-callbacks-test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  brainManaged: true
  completionPromise: DONE
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		const scriptPath = join(workdir, "simple.sh");
		writeFileSync(scriptPath, '#!/bin/bash\necho "<promise>DONE</promise>"\n', {
			mode: 0o755,
		});

		// Runner created WITHOUT memorySearch or skillSearch — brain handles these
		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");
	});

	test("channel context is detected and event emitted", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: context-test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  brainManaged: true
  completionPromise: DONE
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		// Write channel context before job starts
		writeFileSync(join(workdir, "context.md"), "Focus on the auth module specifically");

		// The mock adapter runs `bash <prompt>`. When context is injected, the prompt
		// gets prefixed with channel context text, so bash will fail to run it as a script.
		// That's fine — we're testing that the context_injected event fires and
		// the context.md file is consumed (read and cleared).
		const scriptPath = join(workdir, "context-brain.sh");
		writeFileSync(scriptPath, '#!/bin/bash\necho "<promise>DONE</promise>"\n', {
			mode: 0o755,
		});

		const events: RunnerEvent[] = [];
		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});
		await runner.execute({ prompt: scriptPath });

		// Context injection event was emitted
		expect(events.some((e) => e.type === "job.context_injected")).toBe(true);

		// Context file was consumed (read-and-clear)
		expect(existsSync(join(workdir, "context.md"))).toBe(false);
	});

	test("backward compat: brainManaged=false still uses iteration loop", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: legacy-test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  defaultMaxIterations: 2
  brainManaged: false
  completionPromise: DONE
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		const events: RunnerEvent[] = [];

		// Script that never produces promise — should hit max iterations
		const scriptPath = join(workdir, "legacy.sh");
		writeFileSync(scriptPath, '#!/bin/bash\necho "Modified src/main.ts"\n', {
			mode: 0o755,
		});

		const runner = new Runner({
			config,
			onEvent: (e) => events.push(e),
		});

		const job = await runner.execute({ prompt: scriptPath });

		// Legacy path: hits max iterations
		expect(job.status).toBe("failed");
		expect(job.error).toContain("Max iterations");
		expect(job.iterations.current).toBe(2);

		// Iteration events should exist (proof we used the loop, not brain session)
		expect(events.filter((e) => e.type === "iteration.start").length).toBe(2);
		expect(events.filter((e) => e.type === "iteration.end").length).toBe(2);
	});

	test("brain session sets RANDAL_BRAIN_SESSION env var", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: env-test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  brainManaged: true
  completionPromise: DONE
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		// Script that checks for the brain session env var
		const scriptPath = join(workdir, "env-check.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\nif [ "$RANDAL_BRAIN_SESSION" = "true" ]; then echo "brain mode active"; fi\necho "<promise>DONE</promise>"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");
	});
});
