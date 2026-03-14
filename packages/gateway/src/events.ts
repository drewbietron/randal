import type { RunnerEvent } from "@randal/core";

export type EventSubscriber = (event: RunnerEvent) => void;

/**
 * Simple pub/sub event bus for runner events.
 */
export class EventBus {
	private subscribers: Set<EventSubscriber> = new Set();

	subscribe(handler: EventSubscriber): () => void {
		this.subscribers.add(handler);
		return () => {
			this.subscribers.delete(handler);
		};
	}

	emit(event: RunnerEvent): void {
		for (const handler of this.subscribers) {
			try {
				handler(event);
			} catch {
				// Don't let one subscriber crash others
			}
		}
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}
}
