// ---- Token Usage ----
export interface TokenUsage {
	input: number;
	output: number;
}

// ---- Tool Use Event ----
export interface ToolUseEvent {
	tool: string;
	args?: string;
}

// ---- Runner Events ----
export type RunnerEventType =
	| "job.queued"
	| "job.started"
	| "iteration.start"
	| "iteration.tool_use"
	| "iteration.end"
	| "job.plan_updated"
	| "job.delegation.started"
	| "job.delegation.completed"
	| "job.stuck"
	| "job.context_injected"
	| "job.complete"
	| "job.failed"
	| "job.stopped"
	// Scheduler events:
	| "heartbeat.tick"
	| "heartbeat.skip"
	| "heartbeat.error"
	| "cron.fired"
	| "cron.skipped"
	| "cron.added"
	| "cron.removed"
	| "hook.received"
	| "hook.queued";

export interface RunnerEvent {
	type: RunnerEventType;
	jobId: string;
	timestamp: string;
	data: {
		iteration?: number;
		maxIterations?: number;
		filesChanged?: string[];
		tokensUsed?: TokenUsage;
		duration?: number;
		summary?: string;
		toolName?: string;
		toolArgs?: string;
		struggleIndicators?: string[];
		contextText?: string;
		error?: string;
		exitCode?: number;
		plan?: JobPlanTask[];
		delegationTask?: string;
		delegationJobId?: string;
		delegationStatus?: JobStatus;
		// Scheduler event data:
		cronJobName?: string;
		hookSource?: string;
		wakeMode?: "now" | "next-heartbeat";
		heartbeatTickNumber?: number;
	};
}

// ---- Job ----
export type JobStatus = "queued" | "running" | "complete" | "failed" | "stopped";

export interface JobIteration {
	number: number;
	startedAt: string;
	duration: number;
	filesChanged: string[];
	tokens: TokenUsage;
	exitCode: number;
	promiseFound: boolean;
	summary: string;
	stderr?: string;
	planUpdate?: JobPlanTask[];
	progress?: string;
	delegationRequests?: DelegationRequest[];
}

export interface JobPlanTask {
	task: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	updatedAt?: string;
	iterationNumber?: number;
}

export interface Job {
	id: string;
	status: JobStatus;
	prompt: string;
	spec?: {
		file?: string;
		content?: string;
	};
	agent: string;
	model: string;
	maxIterations: number;
	workdir: string;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	duration: number | null;
	iterations: {
		current: number;
		history: JobIteration[];
	};
	plan: JobPlanTask[];
	progressHistory: string[];
	delegations: DelegationResult[];
	parentJobId?: string;
	cost: {
		totalTokens: TokenUsage;
		estimatedCost: number;
		wallTime: number;
	};
	updates: string[];
	error: string | null;
	exitCode: number | null;
	origin?: JobOrigin;
}

// ---- Delegation ----
export interface DelegationRequest {
	task: string;
	context?: string;
	agent?: string;
	model?: string;
	maxIterations?: number;
}

export interface DelegationResult {
	jobId: string;
	task: string;
	status: JobStatus;
	summary: string;
	filesChanged: string[];
	duration: number;
	error?: string;
}

// ---- Job Origin (channel-aware routing) ----
export interface JobOrigin {
	channel: string; // "http" | "discord" | "imessage"
	replyTo: string; // Discord channelId, iMessage chatGuid, or "http"
	from: string; // Discord userId, phone number, or "api"
}

// ---- Memory ----
export type MemoryDocType = "snapshot" | "learning" | "context";
export type MemoryCategory =
	| "preference"
	| "pattern"
	| "fact"
	| "lesson"
	| "escalation"
	| "skill-outcome";
export type MemorySource = "self" | `agent:${string}` | "human";

// ---- Skills ----
export interface SkillMeta {
	name: string;
	description: string;
	tags?: string[];
	requires?: {
		env?: string[];
		binaries?: string[];
	};
	version?: number;
	[key: string]: unknown;
}

export interface SkillDoc {
	meta: SkillMeta;
	content: string;
	filePath: string;
	updated: string;
}

export interface SkillDeployment {
	name: string;
	description: string;
	content: string;
	frontmatter: Record<string, unknown>;
}

export interface SkillCleanup {
	deployedPaths: string[];
	cleanup: () => Promise<void>;
}

export interface MemoryDoc {
	id: string;
	type: MemoryDocType;
	file: string;
	content: string;
	contentHash: string;
	category: MemoryCategory;
	source: MemorySource;
	timestamp: string;
	jobId?: string;
	iteration?: number;
}

// ---- Messages ----
export interface Message {
	id: string;
	channel: string;
	from: string;
	text: string;
	timestamp: string;
}
