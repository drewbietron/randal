import { describe, expect, test } from "bun:test";
import { assemblePrompt, formatRules } from "./prompt-assembly.js";

describe("formatRules", () => {
	test("formats rules as numbered list", () => {
		const result = formatRules(["Rule A", "Rule B"]);
		expect(result).toBe("1. Rule A\n2. Rule B");
	});

	test("returns empty string for no rules", () => {
		expect(formatRules([])).toBe("");
	});
});

describe("assemblePrompt", () => {
	test("includes persona", () => {
		const result = assemblePrompt({
			persona: "You are a helper",
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
		});
		expect(result).toContain("You are a helper");
	});

	test("includes system prompt", () => {
		const result = assemblePrompt({
			systemPrompt: "Write learnings to MEMORY.md",
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
		});
		expect(result).toContain("Write learnings to MEMORY.md");
	});

	test("includes rules section", () => {
		const result = assemblePrompt({
			rules: ["Never delete data", "Always verify"],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
		});
		expect(result).toContain("## Rules");
		expect(result).toContain("1. Never delete data");
		expect(result).toContain("2. Always verify");
	});

	test("includes knowledge section", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: ["--- file.md ---\nSome knowledge"],
			skills: [],
			discoveredSkills: [],
			memory: [],
		});
		expect(result).toContain("## Knowledge");
		expect(result).toContain("Some knowledge");
	});

	test("includes skills section", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: ["--- Skill: steer ---\nGUI control tool"],
			discoveredSkills: [],
			memory: [],
		});
		expect(result).toContain("## Available Tools");
		expect(result).toContain("GUI control tool");
	});

	test("includes discovered skills section", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: ["--- Skill: notion-api ---\nNotion API docs"],
			memory: [],
		});
		expect(result).toContain("## Active Skills");
		expect(result).toContain("Notion API docs");
	});

	test("includes memory section", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: ["User prefers TypeScript"],
		});
		expect(result).toContain("## Relevant Memory");
		expect(result).toContain("User prefers TypeScript");
	});

	test("includes injected context", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
			injectedContext: "Focus on the auth module",
		});
		expect(result).toContain("## Human Context");
		expect(result).toContain("Focus on the auth module");
	});

	test("omits empty sections", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
		});
		expect(result).toBe("");
	});

	test("combines all sections", () => {
		const result = assemblePrompt({
			persona: "You are Meeles",
			systemPrompt: "Write to MEMORY.md",
			rules: ["Never delete"],
			knowledge: ["--- help.md ---\nHelp content"],
			skills: ["--- Skill: steer ---\nGUI tool"],
			discoveredSkills: ["--- Skill: notion ---\nNotion API"],
			memory: ["Prior context"],
			injectedContext: "Injected text",
		});
		expect(result).toContain("You are Meeles");
		expect(result).toContain("Write to MEMORY.md");
		expect(result).toContain("## Rules");
		expect(result).toContain("## Knowledge");
		expect(result).toContain("## Available Tools");
		expect(result).toContain("## Active Skills");
		expect(result).toContain("## Relevant Memory");
		expect(result).toContain("## Human Context");
	});

	test("Active Skills appears between Available Tools and Relevant Memory", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: ["--- Skill: steer ---\nSteer tool"],
			discoveredSkills: ["--- Skill: notion ---\nNotion skill"],
			memory: ["Some memory"],
		});

		const toolsIdx = result.indexOf("## Available Tools");
		const activeIdx = result.indexOf("## Active Skills");
		const memoryIdx = result.indexOf("## Relevant Memory");

		expect(toolsIdx).toBeLessThan(activeIdx);
		expect(activeIdx).toBeLessThan(memoryIdx);
	});
});
