import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, resolvePromptValue } from "@randal/core";
import type { PromptContext, RunnerEvent } from "@randal/core";
import type { Runner } from "@randal/runner";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---- Duration parsing ----

/**
 * Parse a human-readable duration string into milliseconds.
 * Supports: "30m", "1h", "15m", "7d", "2h30m", "500ms"
 */
export function parseDuration(input: string): number {
	let ms = 0;
	const pattern = /(\d+)\s*(ms|s|m|h|d)/gi;
	let hasMatch = false;

	for (let match = pattern.exec(input); match !== null; match = pattern.exec(input)) {
		hasMatch = true;
		const value = Number.parseInt(match[1], 10);
		const unit = match[2].toLowerCase();

		switch (unit) {
			case "ms":
				ms += value;
				break;
			case "s":
				ms += value * 1000;
				break;
			case "m":
				ms += value * 60 * 1000;
				break;
			case "h":
				ms += value * 60 * 60 * 1000;
				break;
			case "d":
				ms += value * 24 * 60 * 60 * 1000;
				break;
		}
	}

	if (!hasMatch) {
		throw new Error(`Invalid duration string: "${input}"`);
	}

	return ms;
}

// ---- Types ----

export interface HeartbeatConfig {
	enabled: boolean;
	every: string;
	prompt: string;
	activeHours?: {
		start?: string;
		end?: string;
		timezone?: string;
	};
	target: string;
	model?: string;
}

export interface HeartbeatState {
	lastTick: string | null;
	nextTick: string | null;
	tickCount: number;
	pendingWakeItems: WakeItem[];
}

export interface WakeItem {
	text: string;
	source: "hook" | "cron" | "brain";
	timestamp: string;
}

export type HeartbeatEventHandler = (event: RunnerEvent) => void;

export interface HeartbeatOptions {
	config: HeartbeatConfig;
	runner: Runner;
	onEvent?: HeartbeatEventHandler;
	configBasePath?: string;
	memorySearch?: (query: string) => Promise<string[]>;
	/** Template variables for prompt resolution (from identity.vars + auto-populated) */
	promptVars?: Record<string, string>;
}

// ---- Active hours logic ----

function parseTimeHHMM(time: string): { hours: number; minutes: number } {
	const parts = time.split(":");
	return {
		hours: Number.parseInt(parts[0], 10),
		minutes: Number.parseInt(parts[1], 10),
	};
}

/**
 * Check if the current time is within the active hours window.
 * If no active hours are configured, always returns true.
 */
export function isWithinActiveHours(
	activeHours?: HeartbeatConfig["activeHours"],
	now?: Date,
): boolean {
	if (!activeHours) return true;
	if (!activeHours.start && !activeHours.end) return true;

	const currentDate = now ?? new Date();
	const tz = activeHours.timezone ?? "UTC";

	// Get current time in the configured timezone
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	const parts = formatter.formatToParts(currentDate);
	const currentHour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
	const currentMinute = Number.parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
	const currentMinutes = currentHour * 60 + currentMinute;

	if (activeHours.start) {
		const start = parseTimeHHMM(activeHours.start);
		const startMinutes = start.hours * 60 + start.minutes;
		if (currentMinutes < startMinutes) return false;
	}

	if (activeHours.end) {
		const end = parseTimeHHMM(activeHours.end);
		const endMinutes = end.hours * 60 + end.minutes;
		if (currentMinutes >= endMinutes) return false;
	}

	return true;
}

// ---- Heartbeat state persistence ----

let heartbeatStateDir = join(homedir(), ".randal");
let heartbeatStateFile = join(heartbeatStateDir, "heartbeat-state.yaml");

/**
 * Set the heartbeat state file directory (for testing).
 */
export function setHeartbeatStateDir(dir: string): void {
	heartbeatStateDir = dir;
	heartbeatStateFile = join(dir, "heartbeat-state.yaml");
}

interface PersistedHeartbeatState {
	tickCount: number;
	lastTick: string | null;
	wakeQueue: Array<{ text: string; source: string; timestamp: string }>;
}

function loadPersistedHeartbeatState(): PersistedHeartbeatState | null {
	try {
		if (existsSync(heartbeatStateFile)) {
			const raw = readFileSync(heartbeatStateFile, "utf-8");
			return parseYaml(raw) as PersistedHeartbeatState;
		}
	} catch {
		// Ignore read errors
	}
	return null;
}

function savePersistedHeartbeatState(state: PersistedHeartbeatState): void {
	try {
		if (!existsSync(heartbeatStateDir)) {
			mkdirSync(heartbeatStateDir, { recursive: true });
		}
		// Atomic write: write to temp file then rename
		const tmp = `${heartbeatStateFile}.tmp`;
		writeFileSync(tmp, stringifyYaml(state), "utf-8");
		renameSync(tmp, heartbeatStateFile);
	} catch {
		// Ignore write errors — persistence is best-effort
	}
}

// ---- Heartbeat class ----

const logger = createLogger({ context: { component: "heartbeat" } });

export class Heartbeat {
	private config: HeartbeatConfig;
	private runner: Runner;
	private onEvent: HeartbeatEventHandler;
	private configBasePath: string;
	private memorySearch?: (query: string) => Promise<string[]>;
	private promptVars?: Record<string, string>;

	private intervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private state: HeartbeatState = {
		lastTick: null,
		nextTick: null,
		tickCount: 0,
		pendingWakeItems: [],
	};

	constructor(options: HeartbeatOptions) {
		this.config = options.config;
		this.runner = options.runner;
		this.onEvent = options.onEvent ?? (() => {});
		this.configBasePath = options.configBasePath ?? ".";
		this.memorySearch = options.memorySearch;
		this.promptVars = options.promptVars;
		this.intervalMs = parseDuration(this.config.every);

		// Restore persisted state
		const persisted = loadPersistedHeartbeatState();
		if (persisted) {
			this.state.tickCount = persisted.tickCount ?? 0;
			this.state.lastTick = persisted.lastTick ?? null;
			if (persisted.wakeQueue && Array.isArray(persisted.wakeQueue)) {
				this.state.pendingWakeItems = persisted.wakeQueue.map((w) => ({
					text: w.text,
					source: w.source as WakeItem["source"],
					timestamp: w.timestamp,
				}));
			}
			logger.info("Heartbeat state restored", {
				tickCount: this.state.tickCount,
				pendingWakeItems: this.state.pendingWakeItems.length,
			});
		}
	}

	/**
	 * Start the heartbeat timer.
	 */
	start(): void {
		if (this.timer) return;

		logger.info("Heartbeat started", {
			every: this.config.every,
			intervalMs: this.intervalMs,
		});

		this.state.nextTick = new Date(Date.now() + this.intervalMs).toISOString();

		this.timer = setInterval(() => {
			this.tick().catch((err) => {
				logger.error("Heartbeat tick failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				this.emitEvent("heartbeat.error", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, this.intervalMs);
	}

	/**
	 * Stop the heartbeat timer.
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			this.state.nextTick = null;
			logger.info("Heartbeat stopped");
		}
	}

	/**
	 * Queue a wake item for the next heartbeat tick.
	 */
	queueWakeItem(item: WakeItem): void {
		this.state.pendingWakeItems.push(item);
		logger.info("Wake item queued", { source: item.source, text: item.text.slice(0, 100) });
		this.persistState();
	}

	/**
	 * Force an immediate tick (bypasses active hours).
	 */
	async triggerNow(additionalContext?: string): Promise<void> {
		await this.tick(true, additionalContext);
	}

	/**
	 * Get the current heartbeat state.
	 */
	getState(): HeartbeatState {
		return { ...this.state, pendingWakeItems: [...this.state.pendingWakeItems] };
	}

	/**
	 * Execute a single heartbeat tick.
	 */
	private async tick(force = false, additionalContext?: string): Promise<void> {
		// Check active hours (unless forced)
		if (!force && !isWithinActiveHours(this.config.activeHours)) {
			logger.info("Heartbeat skipped (outside active hours)");
			this.emitEvent("heartbeat.skip", {
				heartbeatTickNumber: this.state.tickCount + 1,
			});
			this.state.nextTick = new Date(Date.now() + this.intervalMs).toISOString();
			return;
		}

		this.state.tickCount++;
		const tickNumber = this.state.tickCount;
		this.state.lastTick = new Date().toISOString();
		this.state.nextTick = new Date(Date.now() + this.intervalMs).toISOString();

		logger.info("Heartbeat tick", { tickNumber });

		// Load heartbeat prompt
		let prompt = await this.loadPrompt();

		// Append additional context (from triggerNow)
		if (additionalContext) {
			prompt += `\n\n---\n\n## Immediate Context\n\n${additionalContext}`;
		}

		// Collect and append pending wake items
		const wakeItems = [...this.state.pendingWakeItems];
		if (wakeItems.length > 0) {
			prompt += "\n\n---\n\n## Pending Items\n\n";
			for (const item of wakeItems) {
				prompt += `- [${item.source}] ${item.text}\n`;
			}
			this.state.pendingWakeItems = [];
		}

		// Query memory for relevant context
		if (this.memorySearch) {
			try {
				const memories = await this.memorySearch("heartbeat check-in status review");
				if (memories.length > 0) {
					prompt += "\n\n---\n\n## Relevant Memory\n\n";
					for (const mem of memories) {
						prompt += `${mem}\n`;
					}
				}
			} catch {
				// Memory search failed, continue without it
			}
		}

		// Submit lightweight job to runner
		const tickStart = Date.now();
		try {
			await this.runner.execute({
				prompt,
				model: this.config.model,
				maxIterations: 3, // Heartbeat jobs should be quick
			});
		} catch (err) {
			logger.warn("Heartbeat job failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		const duration = Date.now() - tickStart;

		// Persist state after tick
		this.persistState();

		this.emitEvent("heartbeat.tick", {
			heartbeatTickNumber: tickNumber,
			duration: Math.round(duration / 1000),
		});
	}

	/**
	 * Load the heartbeat prompt using the shared prompt resolver.
	 * Supports file references (.md, .txt), code modules (.ts, .js),
	 * template interpolation ({{var}}), and inline strings.
	 */
	private async loadPrompt(): Promise<string> {
		const promptValue = this.config.prompt;
		const ctx: PromptContext = {
			basePath: this.configBasePath,
			vars: this.promptVars,
			configName: this.promptVars?.name,
		};

		try {
			return await resolvePromptValue(promptValue, ctx);
		} catch (err) {
			logger.warn("Heartbeat prompt resolution failed, using default", {
				prompt: promptValue,
				error: err instanceof Error ? err.message : String(err),
			});
			return "Heartbeat check-in: Review pending tasks and current status.";
		}
	}

	/**
	 * Persist heartbeat state to disk (atomic write).
	 */
	private persistState(): void {
		savePersistedHeartbeatState({
			tickCount: this.state.tickCount,
			lastTick: this.state.lastTick,
			wakeQueue: this.state.pendingWakeItems.map((w) => ({
				text: w.text,
				source: w.source,
				timestamp: w.timestamp,
			})),
		});
	}

	private emitEvent(
		type: "heartbeat.tick" | "heartbeat.skip" | "heartbeat.error",
		data: Record<string, unknown>,
	): void {
		this.onEvent({
			type: type as RunnerEvent["type"],
			jobId: "heartbeat",
			timestamp: new Date().toISOString(),
			data: data as RunnerEvent["data"],
		});
	}
}
