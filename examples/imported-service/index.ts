import { createRandal } from "@randal/harness";

const randal = await createRandal({
	configPath: "./randal.config.yaml",
});

console.log(`Agent "${randal.config.name}" is running on port 7600`);

// The agent is now live:
//   - Gateway serving HTTP + channels on port 7600
//   - Scheduler running heartbeats and cron jobs
//   - Memory connected and auto-injecting context
//
// Submit jobs programmatically:
//   await randal.runner.execute({ prompt: "do something" });
//
// Or let the heartbeat + cron + channels handle things autonomously.
//
// Clean shutdown:
//   randal.stop();
