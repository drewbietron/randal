import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RandalConfig } from "@randal/core";
import { parseConfig } from "@randal/core";
import { auditCredentials, buildProcessEnv } from "./env-builder.js";

async function createTempEnv(content: string): Promise<{ dir: string; envPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "randal-test-"));
	const envPath = join(dir, ".env");
	await writeFile(envPath, content);
	return { dir, envPath };
}

function makeConfig(overrides: Partial<RandalConfig["credentials"]> = {}): RandalConfig {
	return parseConfig(`
name: test
runner:
  workdir: /tmp/test
credentials:
  envFile: ./.env
  allow: ${JSON.stringify(overrides.allow ?? ["API_KEY"])}
  inherit: ${JSON.stringify(overrides.inherit ?? ["PATH"])}
`);
}

describe("buildProcessEnv", () => {
	test("includes allowed vars from env file", async () => {
		const { dir } = await createTempEnv("API_KEY=secret123\nOTHER=leak");
		const config = makeConfig({ allow: ["API_KEY"] });
		const env = buildProcessEnv(config, dir);
		expect(env.API_KEY).toBe("secret123");
		expect(env.OTHER).toBeUndefined();
	});

	test("includes inherited vars from process", () => {
		const config = makeConfig({ allow: [], inherit: ["PATH"] });
		const env = buildProcessEnv(config, "/nonexistent");
		expect(env.PATH).toBeDefined();
	});

	test("no leaking of unspecified vars", async () => {
		const { dir } = await createTempEnv("ALLOWED=yes\nSECRET=no\nLEAK=no");
		const config = makeConfig({ allow: ["ALLOWED"], inherit: [] });
		const env = buildProcessEnv(config, dir);
		expect(env.ALLOWED).toBe("yes");
		expect(env.SECRET).toBeUndefined();
		expect(env.LEAK).toBeUndefined();
		// Should ONLY have ALLOWED
		expect(Object.keys(env)).toEqual(["ALLOWED"]);
	});

	test("handles missing env file gracefully", () => {
		const config = makeConfig({ allow: ["API_KEY"], inherit: ["PATH"] });
		const env = buildProcessEnv(config, "/nonexistent/path");
		// Should still have inherited vars
		expect(env.PATH).toBeDefined();
		expect(env.API_KEY).toBeUndefined();
	});
});

describe("auditCredentials", () => {
	test("reports loaded and missing credentials", async () => {
		const { dir } = await createTempEnv("API_KEY=secret");
		const config = makeConfig({
			allow: ["API_KEY", "MISSING_KEY"],
			inherit: ["PATH"],
		});
		const audit = auditCredentials(config, dir);
		expect(audit.loaded).toContain("API_KEY");
		expect(audit.missing).toContain("MISSING_KEY");
		expect(audit.inherited).toContain("PATH");
	});

	test("all allowed are missing when env file absent", () => {
		const config = makeConfig({ allow: ["A", "B"] });
		const audit = auditCredentials(config, "/nonexistent");
		expect(audit.missing).toEqual(["A", "B"]);
		expect(audit.loaded).toEqual([]);
	});
});
