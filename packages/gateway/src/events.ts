import { createLogger } from "@randal/core";
import type { RunnerEvent } from "@randal/core";

export type EventSubscriber = (event: RunnerEvent) => void;

const logger = createLogger({ context: { component: "event-bus" } });

/**
 * Pub/sub event bus for runner events with error logging,
 * subscriber cap, and auto-removal of broken subscribers.
 */
export class EventBus {
	private subscribers: Set<EventSubscriber> = new Set();
	private errorCounts: Map<EventSubscriber, number> = new Map();
	private maxSubscribers: number;
	private maxConsecutiveErrors: number;

	constructor(options?: { maxSubscribers?: number; maxConsecutiveErrors?: number }) {
		this.maxSubscribers = options?.maxSubscribers ?? 100;
		this.maxConsecutiveErrors = options?.maxConsecutiveErrors ?? 3;
	}

	subscribe(handler: EventSubscriber): () => void {
		if (this.subscribers.size >= this.maxSubscribers) {
			throw new Error(`Max subscribers (${this.maxSubscribers}) reached`);
		}
		this.subscribers.add(handler);
		return () => {
			this.subscribers.delete(handler);
			this.errorCounts.delete(handler);
		};
	}

	emit(event: RunnerEvent): void {
		for (const handler of this.subscribers) {
			try {
				handler(event);
				// Reset error count on success
				this.errorCounts.delete(handler);
			} catch (err) {
				logger.warn("EventBus subscriber error", {
					event: event.type,
					error: err instanceof Error ? err.message : String(err),
				});

				// Track consecutive errors
				const count = (this.errorCounts.get(handler) ?? 0) + 1;
				this.errorCounts.set(handler, count);

				// Auto-remove subscriber after too many consecutive errors
				if (count >= this.maxConsecutiveErrors) {
					logger.warn("Auto-removing subscriber after repeated errors", {
						consecutiveErrors: count,
					});
					this.subscribers.delete(handler);
					this.errorCounts.delete(handler);
				}
			}
		}
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}
}
