import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@randal/core";
import { buildProcessEnv } from "@randal/credentials";

describe("credential scoping", () => {
	test("only allowed vars are passed through", async () => {
		const dir = await mkdtemp(join(tmpdir(), "randal-cred-"));
		await writeFile(join(dir, ".env"), "ALLOWED=yes\nSECRET=no\nANOTHER=no");

		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
credentials:
  envFile: ./.env
  allow: [ALLOWED]
  inherit: []
`);
		const env = buildProcessEnv(config, dir);
		expect(env.ALLOWED).toBe("yes");
		expect(env.SECRET).toBeUndefined();
		expect(env.ANOTHER).toBeUndefined();
		expect(Object.keys(env)).toEqual(["ALLOWED"]);
	});

	test("inherited vars come from process.env", async () => {
		const config = parseConfig(`
name: test
runner:
  workdir: /tmp
credentials:
  allow: []
  inherit: [PATH, HOME]
`);
		const env = buildProcessEnv(config, "/nonexistent");
		expect(env.PATH).toBeDefined();
		expect(env.HOME).toBeDefined();
	});
});
