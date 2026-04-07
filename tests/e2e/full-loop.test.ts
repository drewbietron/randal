import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import type { RunnerEvent } from "@randal/core";
import { Runner } from "@randal/runner";

describe("full loop E2E", () => {
	test("submit spec, mock agent completes in brain session", async () => {
		const workdir = mkdtempSync(join(tmpdir(), "randal-e2e-"));
		const config = parseConfig(`
name: test-e2e
runner:
  workdir: ${workdir}
  defaultAgent: mock
  completionPromise: DONE
  sessionTimeout: 30
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);
		const events: RunnerEvent[] = [];
		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(
			scriptPath,
			'#!/bin/bash\necho "Tokens used: input=5000, output=1200"\necho "<promise>DONE</promise>"\n',
			{ mode: 0o755 },
		);

		const runner = new Runner({ config, onEvent: (e) => events.push(e) });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");

		const completeEvent = events.find((e) => e.type === "job.complete");
		expect(completeEvent).toBeDefined();
		expect(completeEvent?.jobId).toBe(job.id);
	});

	test("brain session emits progress events before completing", async () => {
		const workdir = mkdtempSync(join(tmpdir(), "randal-e2e-"));
		const config = parseConfig(`
name: test-e2e
runner:
  workdir: ${workdir}
  defaultAgent: mock
  completionPromise: DONE
  sessionTimeout: 30
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);

		const events: RunnerEvent[] = [];
		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(
			scriptPath,
			`#!/bin/bash
echo "Starting work..."
echo "<progress>Step 1: Analyzing requirements</progress>"
sleep 0.1
echo "<progress>Step 2: Implementing changes</progress>"
sleep 0.1
echo "<progress>Step 3: Running tests</progress>"
sleep 0.1
echo "Tokens used: input=3000, output=800"
echo "<promise>DONE</promise>"
`,
			{ mode: 0o755 },
		);

		const runner = new Runner({ config, onEvent: (e) => events.push(e) });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");

		// Progress tags should produce iteration.output events
		const progressEvents = events.filter((e) => e.type === "iteration.output");
		expect(progressEvents.length).toBeGreaterThanOrEqual(3);

		// Job lifecycle events fired in order
		expect(events.some((e) => e.type === "job.queued")).toBe(true);
		expect(events.some((e) => e.type === "job.started")).toBe(true);
		expect(events.some((e) => e.type === "job.complete")).toBe(true);
	});
});
