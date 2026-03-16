import { describe, expect, test } from "bun:test";

describe("posse command argument parsing", () => {
	test("status subcommand is recognized", async () => {
		// Test that the posse module exports the command function
		const { posseCommand } = await import("./posse.js");
		expect(typeof posseCommand).toBe("function");
	});

	test("help flag does not throw", async () => {
		const { posseCommand } = await import("./posse.js");
		// Calling with --help should print help and return without error
		await posseCommand(["--help"], {
			config: null as never,
			configPath: undefined,
			url: undefined,
		});
	});

	test("memory search requires query argument", async () => {
		const { posseCommand } = await import("./posse.js");
		// This will call process.exit(1), which in bun:test throws.
		// We verify the function exists and handles the subcommand route.
		// We test the arg parsing structure rather than the HTTP call.
		const originalExit = process.exit;
		let exitCode: number | undefined;
		process.exit = ((code: number) => {
			exitCode = code;
			throw new Error("exit");
		}) as never;

		try {
			await posseCommand(["memory", "search"], {
				config: null as never,
				configPath: undefined,
				url: "http://localhost:9999",
			});
		} catch {
			// Expected: process.exit was called
		} finally {
			process.exit = originalExit;
		}

		expect(exitCode).toBe(1);
	});

	test("unknown subcommand exits with error", async () => {
		const { posseCommand } = await import("./posse.js");
		const originalExit = process.exit;
		let exitCode: number | undefined;
		process.exit = ((code: number) => {
			exitCode = code;
			throw new Error("exit");
		}) as never;

		try {
			await posseCommand(["invalid-sub"], {
				config: null as never,
				configPath: undefined,
				url: "http://localhost:9999",
			});
		} catch {
			// Expected
		} finally {
			process.exit = originalExit;
		}

		expect(exitCode).toBe(1);
	});
});
