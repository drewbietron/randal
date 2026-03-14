import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "@randal/core";
import type { RunnerEvent } from "@randal/core";
import type { Runner } from "@randal/runner";

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
	source: "hook" | "cron";
	timestamp: string;
}

export type HeartbeatEventHandler = (event: RunnerEvent) => void;

export interface HeartbeatOptions {
	config: HeartbeatConfig;
	runner: Runner;
	onEvent?: HeartbeatEventHandler;
	configBasePath?: string;
	memorySearch?: (query: string) => Promise<string[]>;
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

// ---- Heartbeat class ----

const logger = createLogger({ context: { component: "heartbeat" } });

export class Heartbeat {
	private config: HeartbeatConfig;
	private runner: Runner;
	private onEvent: HeartbeatEventHandler;
	private configBasePath: string;
	private memorySearch?: (query: string) => Promise<string[]>;

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
		this.intervalMs = parseDuration(this.config.every);
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
		let prompt = this.loadPrompt();

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

		this.emitEvent("heartbeat.tick", {
			heartbeatTickNumber: tickNumber,
			duration: Math.round(duration / 1000),
		});
	}

	/**
	 * Load the heartbeat prompt from file or use inline string.
	 */
	private loadPrompt(): string {
		const promptValue = this.config.prompt;

		// Check if it looks like a file path
		if (
			promptValue.startsWith("./") ||
			promptValue.startsWith("/") ||
			promptValue.endsWith(".md") ||
			promptValue.endsWith(".txt")
		) {
			const filePath = resolve(this.configBasePath, promptValue);
			if (existsSync(filePath)) {
				return readFileSync(filePath, "utf-8");
			}
			logger.warn("Heartbeat prompt file not found, using default", { path: filePath });
			return "Heartbeat check-in: Review pending tasks and current status.";
		}

		// Treat as inline prompt
		return promptValue;
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
