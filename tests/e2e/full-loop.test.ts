import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import type { RunnerEvent } from "@randal/core";
import { Runner } from "@randal/runner";

describe("full loop E2E", () => {
	test("submit spec, mock agent completes in 1 iteration", async () => {
		const workdir = mkdtempSync(join(tmpdir(), "randal-e2e-"));
		const config = parseConfig(`
name: test-e2e
runner:
  workdir: ${workdir}
  defaultAgent: mock
  defaultMaxIterations: 5
  completionPromise: DONE
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
		expect(job.iterations.current).toBe(1);
		expect(events.filter((e) => e.type === "iteration.end")).toHaveLength(1);

		const completeEvent = events.find((e) => e.type === "job.complete");
		expect(completeEvent).toBeDefined();
		expect(completeEvent?.jobId).toBe(job.id);
	});

	test("mock agent runs multiple iterations before completing", async () => {
		const workdir = mkdtempSync(join(tmpdir(), "randal-e2e-"));
		const config = parseConfig(`
name: test-e2e
runner:
  workdir: ${workdir}
  defaultAgent: mock
  defaultMaxIterations: 10
  completionPromise: DONE
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
`);
		// Script that completes on 3rd iteration
		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(
			scriptPath,
			`#!/bin/bash
ITER_FILE="/tmp/randal-e2e-iter-\${RANDAL_JOB_ID:-default}"
CURRENT=\$(($(cat "\$ITER_FILE" 2>/dev/null || echo 0) + 1))
echo "\$CURRENT" > "\$ITER_FILE"
echo "Modified src/iter-\$CURRENT.ts"
echo "Tokens used: input=3000, output=800"
if [ "\$CURRENT" -ge 3 ]; then
  echo "<promise>DONE</promise>"
fi
`,
			{ mode: 0o755 },
		);

		const runner = new Runner({ config });
		const job = await runner.execute({ prompt: scriptPath });

		expect(job.status).toBe("complete");
		expect(job.iterations.current).toBe(3);
	});
});
