import type { TokenUsage } from "@randal/core";
import type { AgentAdapter } from "./adapter.js";

/**
 * Mock adapter for testing. Uses a shell script that simulates
 * agent behavior with iteration tracking.
 */
export const mock: AgentAdapter = {
	binary: "bash",
	buildCommand(opts) {
		// The prompt is the path to the mock script
		return [opts.prompt];
	},
	parseUsage(output: string): TokenUsage | null {
		const match = output.match(/Tokens used: input=(\d+), output=(\d+)/);
		if (match) {
			return {
				input: Number.parseInt(match[1], 10),
				output: Number.parseInt(match[2], 10),
			};
		}
		return null;
	},
	envOverrides(opts) {
		return {
			RANDAL_WORKDIR: opts.workdir,
		};
	},
};
