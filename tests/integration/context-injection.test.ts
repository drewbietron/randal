import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasContext, readAndClearContext, writeContext } from "@randal/runner";

function makeTmpDir() {
	return mkdtempSync(join(tmpdir(), "randal-ctx-int-"));
}

describe("context injection integration", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) {
			try {
				rmSync(d, { recursive: true });
			} catch {}
		}
		dirs.length = 0;
	});

	test("write context, verify exists, read and clear", () => {
		const dir = makeTmpDir();
		dirs.push(dir);

		expect(hasContext(dir)).toBe(false);
		writeContext(dir, "Focus on error handling");
		expect(hasContext(dir)).toBe(true);

		const content = readAndClearContext(dir);
		expect(content).toBe("Focus on error handling");
		expect(hasContext(dir)).toBe(false);
	});

	test("multiple context injections append", () => {
		const dir = makeTmpDir();
		dirs.push(dir);

		writeContext(dir, "First context");
		writeContext(dir, "Second context");

		const content = readAndClearContext(dir);
		expect(content).toContain("First context");
		expect(content).toContain("Second context");
	});
});
