import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import type { RunnerEvent } from "@randal/core";
import { EventBus } from "@randal/gateway";
import { Runner } from "@randal/runner";

function makeTmpDir() {
	return mkdtempSync(join(tmpdir(), "randal-int-"));
}

describe("runner-gateway integration", () => {
	test("events flow from runner to gateway SSE bus", async () => {
		const workdir = makeTmpDir();
		const config = parseConfig(`
name: test
runner:
  workdir: ${workdir}
  defaultAgent: mock
  defaultMaxIterations: 3
credentials:
  allow: []
  inherit: [PATH, HOME, SHELL]
gateway:
  channels:
    - type: http
      port: 7600
      auth: test-token
`);
		const eventBus = new EventBus();
		const events: RunnerEvent[] = [];
		eventBus.subscribe((e) => events.push(e));

		const scriptPath = join(workdir, "agent.sh");
		writeFileSync(scriptPath, '#!/bin/bash\necho "<promise>DONE</promise>"\n', { mode: 0o755 });

		const runner = new Runner({
			config,
			onEvent: (e) => eventBus.emit(e),
		});

		await runner.execute({ prompt: scriptPath });

		expect(events.some((e) => e.type === "job.started")).toBe(true);
		expect(events.some((e) => e.type === "job.complete")).toBe(true);
	});
});
