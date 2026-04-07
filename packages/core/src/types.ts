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
	| "iteration.output"
	| "iteration.end"
	| "job.plan_updated"
	| "job.delegation.started"
	| "job.delegation.completed"
	| "job.stuck"
	| "job.context_injected"
	| "job.compacted"
	| "job.complete"
	| "job.failed"
	| "job.stopped"
	| "job.resumed"
	// Scheduler events:
	| "heartbeat.tick"
	| "heartbeat.skip"
	| "heartbeat.error"
	| "cron.fired"
	| "cron.skipped"
	| "cron.added"
	| "cron.removed"
	| "hook.received"
	| "hook.queued"
	// System events:
	| "system.update";

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
		output?: string;
		plan?: JobPlanTask[];
		delegationTask?: string;
		delegationJobId?: string;
		delegationStatus?: JobStatus;
		// Streaming event data:
		outputLine?: string;
		// Compaction event data:
		iterationsCompacted?: number;
		originalTokens?: number;
		compactedTokens?: number;
		// Scheduler event data:
		cronJobName?: string;
		hookSource?: string;
		wakeMode?: "now" | "next-heartbeat";
		heartbeatTickNumber?: number;
		// System event data:
		message?: string;
		fromVersion?: string;
		toVersion?: string;
	};
}

// ---- Annotation ----
export type AnnotationVerdict = "pass" | "fail" | "partial";

export interface Annotation {
	id: string;
	jobId: string;
	verdict: AnnotationVerdict;
	feedback?: string;
	categories?: string[];
	agent: string;
	model: string;
	domain?: string;
	iterationCount: number;
	tokenCost: number;
	duration: number;
	filesChanged: string[];
	prompt: string;
	timestamp: string;
}

// ---- Mesh Instance ----
export interface MeshInstance {
	instanceId: string;
	name: string;
	posse?: string;
	capabilities: string[];
	specialization?: string;
	status: "idle" | "busy" | "unhealthy" | "offline";
	lastHeartbeat: string;
	endpoint: string;
	models: string[];
	activeJobs: number;
	completedJobs: number;
	health: {
		uptime: number;
		missedPings: number;
	};
}

// ---- Analytics ----
export interface ReliabilityScore {
	dimension: string;
	value: string;
	passRate: number;
	totalAnnotations: number;
	passCount: number;
	failCount: number;
	partialCount: number;
}

export interface Recommendation {
	id: string;
	type: "model_switch" | "knowledge_gap" | "split_instance" | "rule_validation" | "general";
	message: string;
	severity: "info" | "warning" | "critical";
	data?: Record<string, unknown>;
	timestamp: string;
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
	output?: string;
	stderr?: string;
	fatalError?: string | null;
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
	triggerType?: "user" | "heartbeat" | "cron" | "hook";
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
	scope?: string;
}

// ---- Messages ----
export interface Message {
	id: string;
	channel: string;
	from: string;
	text: string;
	timestamp: string;
}

// ---- Message History ----
export type MessageSpeaker = "user" | "randal" | `agent:${string}`;

export interface MessageDoc {
	id: string;
	threadId: string;
	speaker: MessageSpeaker;
	channel: string;
	content: string;
	timestamp: string;
	jobId?: string;
	pendingAction?: string;
	/** Scope: "global" or "project:/path" — same pattern as MemoryDoc */
	scope?: string;
	/** Discriminator: regular message vs. session summary */
	type?: "message" | "summary";
	/** Populated only for type: "summary" — the condensed summary text */
	summary?: string;
	/** For summaries: how many messages this summary covers */
	messageCount?: number;
	/** Extracted topic keywords for better search matching */
	topicKeywords?: string[];
}
