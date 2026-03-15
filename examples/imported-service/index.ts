/**
 * Programmatic usage example.
 *
 * This file shows how to import @randal/harness and boot Randal from
 * your own TypeScript code. This is useful when you need custom startup
 * logic beyond what the CLI + pre-start.sh hook provides.
 *
 * For most deployments, you don't need this file — just extend the
 * official Docker image and provide a randal.config.yaml. The image's
 * entrypoint runs `randal serve` automatically.
 *
 * To use this instead, override the CMD in your Dockerfile:
 *   CMD ["bun", "run", "index.ts"]
 */

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
