import { describe, expect, test } from "bun:test";
import type { LogEntry } from "./logger.js";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
	test("logs at info level by default", () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({ output: (e) => entries.push(e) });

		logger.info("hello");
		logger.debug("hidden");

		expect(entries).toHaveLength(1);
		expect(entries[0].level).toBe("info");
		expect(entries[0].msg).toBe("hello");
	});

	test("respects log level setting", () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({
			level: "warn",
			output: (e) => entries.push(e),
		});

		logger.debug("no");
		logger.info("no");
		logger.warn("yes");
		logger.error("yes");

		expect(entries).toHaveLength(2);
		expect(entries[0].level).toBe("warn");
		expect(entries[1].level).toBe("error");
	});

	test("debug level logs everything", () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({
			level: "debug",
			output: (e) => entries.push(e),
		});

		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");

		expect(entries).toHaveLength(4);
	});

	test("includes timestamp", () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({ output: (e) => entries.push(e) });

		logger.info("test");

		expect(entries[0].ts).toBeDefined();
		expect(typeof entries[0].ts).toBe("string");
		// Should be valid ISO string
		expect(() => new Date(entries[0].ts)).not.toThrow();
	});

	test("includes extra data", () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({ output: (e) => entries.push(e) });

		logger.info("test", { jobId: "abc", iteration: 3 });

		expect(entries[0].jobId).toBe("abc");
		expect(entries[0].iteration).toBe(3);
	});

	test("child logger inherits context", () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({ output: (e) => entries.push(e) });
		const child = logger.child({ component: "runner" });

		child.info("started");

		expect(entries[0].component).toBe("runner");
		expect(entries[0].msg).toBe("started");
	});

	test("child logger merges context with parent", () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({
			output: (e) => entries.push(e),
			context: { service: "randal" },
		});
		const child = logger.child({ component: "runner" });

		child.info("started");

		expect(entries[0].service).toBe("randal");
		expect(entries[0].component).toBe("runner");
	});

	test("child inherits parent log level", () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({
			level: "error",
			output: (e) => entries.push(e),
		});
		const child = logger.child({ component: "runner" });

		child.info("hidden");
		child.error("visible");

		expect(entries).toHaveLength(1);
		expect(entries[0].level).toBe("error");
	});
});
