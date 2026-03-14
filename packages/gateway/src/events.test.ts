import { describe, expect, test } from "bun:test";
import type { RunnerEvent } from "@randal/core";
import { EventBus } from "./events.js";

describe("EventBus", () => {
	function makeEvent(type: string): RunnerEvent {
		return {
			type: type as RunnerEvent["type"],
			jobId: "test-id",
			timestamp: new Date().toISOString(),
			data: {},
		};
	}

	test("subscriber receives events", () => {
		const bus = new EventBus();
		const events: RunnerEvent[] = [];
		bus.subscribe((e) => events.push(e));

		bus.emit(makeEvent("job.started"));
		expect(events).toHaveLength(1);
	});

	test("multiple subscribers receive events", () => {
		const bus = new EventBus();
		const events1: RunnerEvent[] = [];
		const events2: RunnerEvent[] = [];
		bus.subscribe((e) => events1.push(e));
		bus.subscribe((e) => events2.push(e));

		bus.emit(makeEvent("job.started"));
		expect(events1).toHaveLength(1);
		expect(events2).toHaveLength(1);
	});

	test("unsubscribe stops receiving events", () => {
		const bus = new EventBus();
		const events: RunnerEvent[] = [];
		const unsub = bus.subscribe((e) => events.push(e));

		bus.emit(makeEvent("job.started"));
		unsub();
		bus.emit(makeEvent("job.complete"));

		expect(events).toHaveLength(1);
	});

	test("subscriber count tracks correctly", () => {
		const bus = new EventBus();
		expect(bus.subscriberCount).toBe(0);

		const unsub = bus.subscribe(() => {});
		expect(bus.subscriberCount).toBe(1);

		unsub();
		expect(bus.subscriberCount).toBe(0);
	});

	test("error in one subscriber does not affect others", () => {
		const bus = new EventBus();
		const events: RunnerEvent[] = [];
		bus.subscribe(() => {
			throw new Error("boom");
		});
		bus.subscribe((e) => events.push(e));

		bus.emit(makeEvent("job.started"));
		expect(events).toHaveLength(1);
	});
});
