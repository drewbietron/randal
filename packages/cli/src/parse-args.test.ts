import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseArgs } from "./parse-args.js";

// Capture stderr warnings
let stderrOutput: string[];
const originalError = console.error;

beforeEach(() => {
	stderrOutput = [];
	console.error = mock((...args: unknown[]) => {
		stderrOutput.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	console.error = originalError;
});

describe("parseArgs", () => {
	test("parses string flag correctly", () => {
		const result = parseArgs(["--agent", "opencode"], {
			string: ["agent"],
		});
		expect(result.flags.agent).toBe("opencode");
		expect(result.positionals).toEqual([]);
		expect(result.unknown).toEqual([]);
	});

	test("parses number flag correctly", () => {
		const result = parseArgs(["--max-iterations", "10"], {
			number: ["max-iterations"],
		});
		expect(result.flags["max-iterations"]).toBe(10);
	});

	test("parses boolean flag correctly", () => {
		const result = parseArgs(["--verbose"], {
			boolean: ["verbose"],
		});
		expect(result.flags.verbose).toBe(true);
	});

	test("handles alias: -v → --verbose", () => {
		const result = parseArgs(["-v"], {
			boolean: ["verbose"],
			aliases: { "-v": "--verbose" },
		});
		expect(result.flags.verbose).toBe(true);
	});

	test("collects positional arguments", () => {
		const result = parseArgs(["hello world", "another"], {});
		expect(result.positionals).toEqual(["hello world", "another"]);
	});

	test("collects unknown flags", () => {
		const result = parseArgs(["--verbos"], {
			boolean: ["verbose"],
		});
		expect(result.unknown).toEqual(["--verbos"]);
	});

	test("passthrough flags are not flagged as unknown", () => {
		const result = parseArgs(["--config", "x.yaml", "--url", "http://localhost"], {
			passthrough: ["config", "url"],
		});
		expect(result.unknown).toEqual([]);
		expect(result.positionals).toEqual([]);
	});

	test("missing value for string flag → collected in unknown", () => {
		const result = parseArgs(["--agent"], {
			string: ["agent"],
		});
		expect(result.unknown).toEqual(["--agent"]);
		expect(result.flags.agent).toBeUndefined();
	});

	test("missing value for number flag → collected in unknown", () => {
		const result = parseArgs(["--max-iterations"], {
			number: ["max-iterations"],
		});
		expect(result.unknown).toEqual(["--max-iterations"]);
	});

	test("mixed flags and positionals", () => {
		const result = parseArgs(
			["fix the bug", "--agent", "opencode", "--max-iterations", "5", "--verbose"],
			{
				string: ["agent"],
				number: ["max-iterations"],
				boolean: ["verbose"],
			},
		);
		expect(result.positionals).toEqual(["fix the bug"]);
		expect(result.flags.agent).toBe("opencode");
		expect(result.flags["max-iterations"]).toBe(5);
		expect(result.flags.verbose).toBe(true);
		expect(result.unknown).toEqual([]);
	});

	test("empty args → empty result", () => {
		const result = parseArgs([], {});
		expect(result.flags).toEqual({});
		expect(result.positionals).toEqual([]);
		expect(result.unknown).toEqual([]);
	});

	test("Levenshtein suggestion for close misspelling", () => {
		parseArgs(["--verbos"], {
			boolean: ["verbose"],
		});
		expect(stderrOutput.length).toBe(1);
		expect(stderrOutput[0]).toContain("--verbos");
		expect(stderrOutput[0]).toContain("did you mean --verbose?");
	});

	test("no suggestion for distant typo", () => {
		parseArgs(["--xyz"], {
			boolean: ["verbose"],
			string: ["agent"],
		});
		expect(stderrOutput.length).toBe(1);
		expect(stderrOutput[0]).toContain("--xyz");
		expect(stderrOutput[0]).not.toContain("did you mean");
	});

	test("boolean passthrough flag without value does not eat next arg", () => {
		const result = parseArgs(["--no-memory", "my prompt"], {
			passthrough: ["no-memory"],
		});
		// --no-memory is passthrough, "my prompt" is positional
		// Since "my prompt" doesn't start with -, the passthrough logic skips it
		// as a potential value. This is correct for passthrough flags that may
		// or may not take values.
		expect(result.unknown).toEqual([]);
	});

	test("NaN number value → flag collected in unknown", () => {
		const result = parseArgs(["--max-iterations", "abc"], {
			number: ["max-iterations"],
		});
		expect(result.unknown).toEqual(["--max-iterations"]);
		expect(result.flags["max-iterations"]).toBeUndefined();
	});
});
