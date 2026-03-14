import { describe, expect, test } from "bun:test";
import { filterAllowed, getInherited, parseEnvFile } from "./credentials.js";

describe("parseEnvFile", () => {
	test("parses simple key=value", () => {
		const result = parseEnvFile("FOO=bar\nBAZ=qux");
		expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	test("handles double-quoted values", () => {
		const result = parseEnvFile('KEY="hello world"');
		expect(result).toEqual({ KEY: "hello world" });
	});

	test("handles single-quoted values", () => {
		const result = parseEnvFile("KEY='hello world'");
		expect(result).toEqual({ KEY: "hello world" });
	});

	test("skips comments", () => {
		const result = parseEnvFile("# comment\nKEY=value\n# another");
		expect(result).toEqual({ KEY: "value" });
	});

	test("skips empty lines", () => {
		const result = parseEnvFile("\n\nKEY=value\n\n");
		expect(result).toEqual({ KEY: "value" });
	});

	test("handles values with = sign", () => {
		const result = parseEnvFile("URL=postgres://user:pass@host/db?opt=val");
		expect(result).toEqual({ URL: "postgres://user:pass@host/db?opt=val" });
	});

	test("returns empty object for empty input", () => {
		expect(parseEnvFile("")).toEqual({});
	});

	test("handles lines without = sign", () => {
		const result = parseEnvFile("INVALID_LINE\nKEY=value");
		expect(result).toEqual({ KEY: "value" });
	});
});

describe("filterAllowed", () => {
	test("returns only allowed keys", () => {
		const vars = { A: "1", B: "2", C: "3" };
		const result = filterAllowed(vars, ["A", "C"]);
		expect(result).toEqual({ A: "1", C: "3" });
	});

	test("skips missing keys", () => {
		const vars = { A: "1" };
		const result = filterAllowed(vars, ["A", "B"]);
		expect(result).toEqual({ A: "1" });
	});

	test("returns empty for empty allow list", () => {
		const result = filterAllowed({ A: "1" }, []);
		expect(result).toEqual({});
	});
});

describe("getInherited", () => {
	test("returns existing env vars", () => {
		// PATH should exist on any system
		const result = getInherited(["PATH"]);
		expect(result.PATH).toBeDefined();
	});

	test("skips undefined vars", () => {
		const result = getInherited(["NONEXISTENT_VAR_ABCXYZ"]);
		expect(result).toEqual({});
	});
});
