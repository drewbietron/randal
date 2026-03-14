import type { AgentAdapter } from "./adapter.js";

export const codex: AgentAdapter = {
	binary: "codex",
	buildCommand(opts) {
		const args = ["--full-auto"];
		if (opts.model) args.push("--model", opts.model);
		args.push(opts.prompt);
		return args;
	},
};
