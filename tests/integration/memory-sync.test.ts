import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import { MemoryManager } from "@randal/memory";

describe("memory sync (file store)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) {
			try {
				rmSync(d, { recursive: true });
			} catch {}
		}
		dirs.length = 0;
	});

	test("indexes file content on init", async () => {
		const dir = mkdtempSync(join(tmpdir(), "randal-mem-sync-"));
		dirs.push(dir);
		writeFileSync(
			join(dir, "MEMORY.md"),
			"- [fact] Test fact about API\n- [preference] Use TypeScript\n",
		);

		const config = parseConfig(`
name: test
runner:
  workdir: ${dir}
memory:
  store: file
  files: [MEMORY.md]
`);
		const mgr = new MemoryManager({ config, basePath: dir });
		await mgr.init();

		const results = await mgr.search("API");
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	test("indexes new documents", async () => {
		const dir = mkdtempSync(join(tmpdir(), "randal-mem-sync-"));
		dirs.push(dir);

		const config = parseConfig(`
name: test
runner:
  workdir: ${dir}
memory:
  store: file
  files: [MEMORY.md]
`);
		const mgr = new MemoryManager({ config, basePath: dir });
		await mgr.init();

		await mgr.index({
			type: "learning",
			file: "MEMORY.md",
			content: "New learning about Supabase",
			contentHash: "test",
			category: "fact",
			source: "self",
			timestamp: new Date().toISOString(),
		});

		const results = await mgr.search("Supabase");
		expect(results.length).toBeGreaterThanOrEqual(1);
	});
});
