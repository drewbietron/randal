import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextFilePath, hasContext, readAndClearContext, writeContext } from "./context.js";

describe("context", () => {
	const tmpDirs: string[] = [];

	function makeTmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "randal-ctx-test-"));
		tmpDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tmpDirs) {
			try {
				rmSync(dir, { recursive: true });
			} catch {
				// ignore
			}
		}
		tmpDirs.length = 0;
	});

	test("contextFilePath returns correct path", () => {
		expect(contextFilePath("/tmp/job")).toBe("/tmp/job/context.md");
	});

	test("readAndClearContext returns null when no file", () => {
		const dir = makeTmpDir();
		expect(readAndClearContext(dir)).toBeNull();
	});

	test("writeContext creates file", () => {
		const dir = makeTmpDir();
		writeContext(dir, "some context");
		expect(hasContext(dir)).toBe(true);
	});

	test("readAndClearContext reads and deletes", () => {
		const dir = makeTmpDir();
		writeContext(dir, "some context");
		const content = readAndClearContext(dir);
		expect(content).toBe("some context");
		expect(hasContext(dir)).toBe(false);
	});

	test("writeContext appends to existing", () => {
		const dir = makeTmpDir();
		writeContext(dir, "first");
		writeContext(dir, "second");
		const content = readAndClearContext(dir);
		expect(content).toBe("first\nsecond");
	});

	test("hasContext returns false when no file", () => {
		const dir = makeTmpDir();
		expect(hasContext(dir)).toBe(false);
	});
});
