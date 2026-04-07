export { Runner } from "./runner.js";
export type { RunnerOptions, JobRequest, EventHandler } from "./runner.js";

export { getAdapter, registerAdapter } from "./agents/index.js";
export type { AgentAdapter, RunOpts } from "./agents/index.js";

export {
	generateToken,
	wrapCommand,
	isStartMarker,
	parseDoneMarker,
	findCompletionPromise,
	parseOutput,
} from "./sentinel.js";

export { detectStruggle } from "./struggle.js";
export type { StruggleConfig, StruggleResult } from "./struggle.js";

export { checkStruggle } from "./struggle-check.js";
export type { StruggleCheckInput, StruggleCheckResult } from "./struggle-check.js";

export { readLoopState, writeLoopState, syncJobToLoopState } from "./loop-state.js";
export type { BuildState, LoopState } from "./loop-state.js";

export {
	readAndClearContext,
	writeContext,
	hasContext,
	contextFilePath,
} from "./context.js";

export {
	assemblePrompt,
	formatRules,
	formatPlan,
	formatProgressHistory,
	formatDelegationResults,
	buildProtocolSection,
	buildSystemPrompt,
	loadKnowledgeFiles,
	loadSkillDocs,
} from "./prompt-assembly.js";
export type { PromptParts } from "./prompt-assembly.js";

export { parsePlanUpdate, parseProgress } from "./plan-parser.js";

/** @deprecated Use the `delegate_task` MCP tool instead. Will be removed in a future version. */
export { parseDelegationRequests } from "./plan-parser.js";

export { readStreamLines, readStream } from "./streaming.js";
export type { StreamingReaderOptions, StreamingResult } from "./streaming.js";

export { parseCallRequests, callRequestSchema } from "./call-parser.js";
export type { CallRequest } from "./call-parser.js";

export { parseJoinCallRequests, joinCallRequestSchema } from "./join-call-parser.js";
export type { JoinCallRequest } from "./join-call-parser.js";

/** @deprecated Use the `delegate_task` MCP tool with auto-routing instead. Will be removed in a future version. */
export { parseRouteRequests, routeRequestSchema } from "./route-parser.js";
/** @deprecated */
export type { RouteRequest } from "./route-parser.js";

export { McpServer } from "./mcp-server.js";
export type { McpServiceHooks } from "./mcp-server.js";

export { shouldCompact, compactContext } from "./compaction.js";
export type { CompactionInput, CompactionResult } from "./compaction.js";

export { BrowserTool } from "./tools/browser.js";
