import type { SkillCleanup, SkillDeployment, TokenUsage, ToolUseEvent } from "@randal/core";

export interface RunOpts {
	prompt: string;
	model?: string;
	systemPrompt?: string;
	workdir: string;
}

export interface AgentAdapter {
	/** Name of the binary to invoke */
	binary: string;
	/** Build the CLI arguments for this agent */
	buildCommand(opts: RunOpts): string[];
	/** Parse token usage from agent output */
	parseUsage?(output: string): TokenUsage | null;
	/** Parse tool use events from a line of output */
	parseToolUse?(line: string): ToolUseEvent | null;
	/** Additional env overrides for this agent */
	envOverrides?(opts: RunOpts): Record<string, string>;

	/** Deploy skills to the agent CLI's native skill directory */
	deploySkills?(skills: SkillDeployment[], workdir: string): Promise<SkillCleanup>;
	/** The directory where this agent CLI expects skills */
	skillDir?: string;

	/** Whether this adapter supports the Randal execution protocol tags. Defaults to true. */
	supportsProtocol?: boolean;
}
