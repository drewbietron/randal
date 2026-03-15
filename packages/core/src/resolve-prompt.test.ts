import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PromptContext } from "./resolve-prompt.js";
import { resolvePromptArray, resolvePromptValue } from "./resolve-prompt.js";

let tempDir: string;
let ctx: PromptContext;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "randal-resolve-test-"));
	ctx = {
		basePath: tempDir,
		vars: {
			name: "test-agent",
			version: "0.1",
			company: "Acme Corp",
		},
		configName: "test-agent",
	};
});

// ── resolvePromptValue ──────────────────────────────────────

describe("resolvePromptValue", () => {
	// Layer 0: Inline passthrough
	describe("inline passthrough", () => {
		test("returns plain text as-is", async () => {
			const result = await resolvePromptValue("You are a helper", ctx);
			expect(result).toBe("You are a helper");
		});

		test("does not interpolate templates in inline strings", async () => {
			const result = await resolvePromptValue("Hello {{name}}", ctx);
			expect(result).toBe("Hello {{name}}");
		});

		test("passes through empty string", async () => {
			const result = await resolvePromptValue("", ctx);
			expect(result).toBe("");
		});

		test("passes through multi-line inline string", async () => {
			const text = "Line 1\nLine 2\nLine 3";
			const result = await resolvePromptValue(text, ctx);
			expect(result).toBe(text);
		});
	});

	// Layer 1: File reference
	describe("file reference (.md)", () => {
		test("loads .md file via relative path", async () => {
			writeFileSync(join(tempDir, "IDENTITY.md"), "You are a test agent.");
			const result = await resolvePromptValue("./IDENTITY.md", ctx);
			expect(result).toBe("You are a test agent.");
		});

		test("loads .md file by extension alone", async () => {
			writeFileSync(join(tempDir, "IDENTITY.md"), "Persona content");
			const result = await resolvePromptValue("IDENTITY.md", ctx);
			expect(result).toBe("Persona content");
		});

		test("loads .txt file", async () => {
			writeFileSync(join(tempDir, "prompt.txt"), "Text file content");
			const result = await resolvePromptValue("./prompt.txt", ctx);
			expect(result).toBe("Text file content");
		});

		test("loads file from absolute path", async () => {
			const absPath = join(tempDir, "abs.md");
			writeFileSync(absPath, "Absolute path content");
			const result = await resolvePromptValue(absPath, ctx);
			expect(result).toBe("Absolute path content");
		});

		test("throws on missing file with descriptive message", async () => {
			await expect(resolvePromptValue("./missing.md", ctx)).rejects.toThrow(
				/Failed to read prompt file.*missing\.md/,
			);
		});

		test("interpolates {{var}} in file content", async () => {
			writeFileSync(
				join(tempDir, "IDENTITY.md"),
				"# {{name}}\n\nYou are {{name}} from {{company}}.",
			);
			const result = await resolvePromptValue("./IDENTITY.md", ctx);
			expect(result).toBe("# test-agent\n\nYou are test-agent from Acme Corp.");
		});

		test("leaves unknown {{var}} as-is", async () => {
			writeFileSync(join(tempDir, "template.md"), "Hello {{unknown}}!");
			const result = await resolvePromptValue("./template.md", ctx);
			expect(result).toBe("Hello {{unknown}}!");
		});

		test("handles nested dotted var names", async () => {
			const ctxWithDotted: PromptContext = {
				...ctx,
				vars: { ...ctx.vars, "app.name": "MyApp" },
			};
			writeFileSync(join(tempDir, "app.md"), "App: {{app.name}}");
			const result = await resolvePromptValue("./app.md", ctxWithDotted);
			expect(result).toBe("App: MyApp");
		});

		test("interpolation with no vars does nothing", async () => {
			const noVarsCtx: PromptContext = { basePath: tempDir };
			writeFileSync(join(tempDir, "plain.md"), "No vars {{here}}");
			const result = await resolvePromptValue("./plain.md", noVarsCtx);
			expect(result).toBe("No vars {{here}}");
		});

		test("loads file from subdirectory via relative path", async () => {
			mkdirSync(join(tempDir, "prompts"), { recursive: true });
			writeFileSync(join(tempDir, "prompts", "system.md"), "Sub dir content");
			const result = await resolvePromptValue("./prompts/system.md", ctx);
			expect(result).toBe("Sub dir content");
		});
	});

	// Layer 3: Code module
	describe("code module (.ts)", () => {
		test("loads and executes .ts module", async () => {
			writeFileSync(
				join(tempDir, "identity.ts"),
				`export default function(ctx) { return "Hello from " + (ctx.vars?.name ?? "agent"); }`,
			);
			const result = await resolvePromptValue("./identity.ts", ctx);
			expect(result).toBe("Hello from test-agent");
		});

		test("loads and executes .js module", async () => {
			writeFileSync(
				join(tempDir, "prompt.js"),
				`export default function(ctx) { return "JS module output"; }`,
			);
			const result = await resolvePromptValue("./prompt.js", ctx);
			expect(result).toBe("JS module output");
		});

		test("supports async default export", async () => {
			writeFileSync(
				join(tempDir, "async-prompt.ts"),
				`export default async function(ctx) { return "Async result"; }`,
			);
			const result = await resolvePromptValue("./async-prompt.ts", ctx);
			expect(result).toBe("Async result");
		});

		test("throws on missing .ts module", async () => {
			await expect(
				resolvePromptValue("./nonexistent.ts", ctx),
			).rejects.toThrow(/Failed to load code module/);
		});

		test("throws when module has no default export function", async () => {
			writeFileSync(
				join(tempDir, "bad-module.ts"),
				`export const foo = "bar";`,
			);
			await expect(
				resolvePromptValue("./bad-module.ts", ctx),
			).rejects.toThrow(/does not export a default function/);
		});

		test("does NOT apply template interpolation to code module output", async () => {
			writeFileSync(
				join(tempDir, "no-interp.ts"),
				`export default function() { return "Hello {{name}}"; }`,
			);
			const result = await resolvePromptValue("./no-interp.ts", ctx);
			// Template vars should NOT be interpolated in module output
			expect(result).toBe("Hello {{name}}");
		});

		test(".ts extension takes priority over file ref detection", async () => {
			// ./foo.ts matches both isFileRef (starts with ./) and isCodeModule (.ts)
			// Code module should win
			writeFileSync(
				join(tempDir, "foo.ts"),
				`export default function() { return "module wins"; }`,
			);
			const result = await resolvePromptValue("./foo.ts", ctx);
			expect(result).toBe("module wins");
		});

		test("bare .ts filename (no ./) is treated as code module", async () => {
			writeFileSync(
				join(tempDir, "identity.ts"),
				`export default function() { return "bare ts"; }`,
			);
			const result = await resolvePromptValue("identity.ts", ctx);
			expect(result).toBe("bare ts");
		});
	});
});

// ── resolvePromptArray ──────────────────────────────────────

describe("resolvePromptArray", () => {
	describe("rules mode", () => {
		test("passes inline strings through as-is", async () => {
			const result = await resolvePromptArray(
				["NEVER delete data", "ALWAYS verify"],
				ctx,
			);
			expect(result).toEqual(["NEVER delete data", "ALWAYS verify"]);
		});

		test("loads file and splits by newlines", async () => {
			writeFileSync(
				join(tempDir, "safety-rules.md"),
				"NEVER expose PII\nALWAYS log actions\nBe concise",
			);
			const result = await resolvePromptArray(["./safety-rules.md"], ctx);
			expect(result).toEqual([
				"NEVER expose PII",
				"ALWAYS log actions",
				"Be concise",
			]);
		});

		test("filters out empty lines from file", async () => {
			writeFileSync(
				join(tempDir, "rules.md"),
				"Rule A\n\nRule B\n\n\nRule C\n",
			);
			const result = await resolvePromptArray(["./rules.md"], ctx);
			expect(result).toEqual(["Rule A", "Rule B", "Rule C"]);
		});

		test("handles mixed inline and file entries", async () => {
			writeFileSync(join(tempDir, "safety-rules.md"), "No PII\nNo deletion");
			const result = await resolvePromptArray(
				["NEVER delete data", "./safety-rules.md"],
				ctx,
			);
			expect(result).toEqual([
				"NEVER delete data",
				"No PII",
				"No deletion",
			]);
		});

		test("loads .ts module returning string array", async () => {
			writeFileSync(
				join(tempDir, "rules.ts"),
				`export default function() { return ["Rule from TS 1", "Rule from TS 2"]; }`,
			);
			const result = await resolvePromptArray(["./rules.ts"], ctx);
			expect(result).toEqual(["Rule from TS 1", "Rule from TS 2"]);
		});

		test("loads .ts module returning string (splits by newline)", async () => {
			writeFileSync(
				join(tempDir, "rules-str.ts"),
				`export default function() { return "Rule A\\nRule B"; }`,
			);
			const result = await resolvePromptArray(["./rules-str.ts"], ctx);
			expect(result).toEqual(["Rule A", "Rule B"]);
		});

		test("throws on missing file in array", async () => {
			await expect(
				resolvePromptArray(["./missing-rules.md"], ctx),
			).rejects.toThrow(/Failed to read prompt file/);
		});

		test("interpolates templates in file content for rules", async () => {
			writeFileSync(
				join(tempDir, "var-rules.md"),
				"{{name}} must always log\n{{company}} policy applies",
			);
			const result = await resolvePromptArray(["./var-rules.md"], ctx);
			expect(result).toEqual([
				"test-agent must always log",
				"Acme Corp policy applies",
			]);
		});
	});

	describe("knowledge mode", () => {
		test("passes glob patterns through as-is", async () => {
			const result = await resolvePromptArray(
				["./knowledge/*.md", "**/*.txt"],
				ctx,
				{ mode: "knowledge" },
			);
			expect(result).toEqual(["./knowledge/*.md", "**/*.txt"]);
		});

		test("resolves file refs with header wrapper", async () => {
			writeFileSync(join(tempDir, "overview.md"), "Overview content");
			const result = await resolvePromptArray(
				["./overview.md"],
				ctx,
				{ mode: "knowledge" },
			);
			expect(result).toEqual(["--- ./overview.md ---\nOverview content"]);
		});

		test("resolves code module with header wrapper", async () => {
			writeFileSync(
				join(tempDir, "kb.ts"),
				`export default function() { return "Dynamic knowledge"; }`,
			);
			const result = await resolvePromptArray(
				["./kb.ts"],
				ctx,
				{ mode: "knowledge" },
			);
			expect(result).toEqual(["--- ./kb.ts ---\nDynamic knowledge"]);
		});

		test("mixes glob patterns with file refs", async () => {
			writeFileSync(join(tempDir, "static.md"), "Static info");
			const result = await resolvePromptArray(
				["./knowledge/*.md", "./static.md"],
				ctx,
				{ mode: "knowledge" },
			);
			expect(result).toEqual([
				"./knowledge/*.md",
				"--- ./static.md ---\nStatic info",
			]);
		});
	});
});
