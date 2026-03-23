import type { AgentAdapter } from "./adapter.js";

export const codex: AgentAdapter = {
	binary: "codex",
	buildCommand(opts) {
		const args = ["--full-auto"];
		if (opts.model) {
			// Strip provider prefix (e.g. "openai/o3" → "o3")
			const cliModel = opts.model.replace(/^openai\//, "");
			args.push("--model", cliModel);
		}
		args.push(opts.prompt);
		return args;
	},
};
