import { describe, expect, test } from "bun:test";
import {
	assemblePrompt,
	buildProtocolSection,
	formatDelegationResults,
	formatPlan,
	formatProgressHistory,
	formatRules,
} from "./prompt-assembly.js";

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

	test("includes protocol section even with no other content", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
		});
		expect(result).toContain("## Randal Execution Protocol");
		expect(result).toContain("<plan-update>");
		expect(result).toContain("<progress>");
		expect(result).toContain("<delegate>");
	});

	test("omits protocol section when includeProtocol is false", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
			includeProtocol: false,
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

	test("includes current plan section", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
			currentPlan: [
				{ task: "Task A", status: "completed", iterationNumber: 1 },
				{ task: "Task B", status: "in_progress", iterationNumber: 2 },
				{ task: "Task C", status: "pending" },
			],
		});
		expect(result).toContain("## Current Task Plan");
		expect(result).toContain("[x] Task A (completed, iteration 1)");
		expect(result).toContain("[>] Task B (in_progress, iteration 2)");
		expect(result).toContain("[ ] Task C (pending)");
	});

	test("includes progress history section", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
			progressHistory: ["First iteration done", "Second iteration done"],
		});
		expect(result).toContain("## Previous Progress");
		expect(result).toContain("### Iteration 1");
		expect(result).toContain("First iteration done");
		expect(result).toContain("### Iteration 2");
		expect(result).toContain("Second iteration done");
	});

	test("includes delegation results section", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
			delegationResults: [
				{
					jobId: "abc123",
					task: "Write tests",
					status: "complete",
					summary: "Created 12 test cases",
					filesChanged: ["src/test.ts"],
					duration: 45,
				},
			],
		});
		expect(result).toContain("## Delegation Results");
		expect(result).toContain("### Task: Write tests");
		expect(result).toContain("Status: complete");
		expect(result).toContain("Job: abc123");
		expect(result).toContain("Duration: 45s");
		expect(result).toContain("Created 12 test cases");
	});

	test("protocol section always present", () => {
		const result = assemblePrompt({
			rules: [],
			knowledge: [],
			skills: [],
			discoveredSkills: [],
			memory: [],
		});
		expect(result).toContain("## Randal Execution Protocol");
		expect(result).toContain("plan-update");
		expect(result).toContain("progress");
		expect(result).toContain("delegate");
		expect(result).toContain("<promise>DONE</promise>");
	});
});

// ── formatPlan ──────────────────────────────────────────────

describe("formatPlan", () => {
	test("formats plan with status icons", () => {
		const result = formatPlan([
			{ task: "Done task", status: "completed", iterationNumber: 1 },
			{ task: "Active task", status: "in_progress", iterationNumber: 2 },
			{ task: "Failed task", status: "failed", iterationNumber: 2 },
			{ task: "Todo task", status: "pending" },
		]);
		expect(result).toContain("[x] Done task (completed, iteration 1)");
		expect(result).toContain("[>] Active task (in_progress, iteration 2)");
		expect(result).toContain("[!] Failed task (failed, iteration 2)");
		expect(result).toContain("[ ] Todo task (pending)");
	});
});

// ── formatProgressHistory ───────────────────────────────────

describe("formatProgressHistory", () => {
	test("formats progress entries with iteration numbers", () => {
		const result = formatProgressHistory(["Did A", "Did B"]);
		expect(result).toContain("### Iteration 1");
		expect(result).toContain("Did A");
		expect(result).toContain("### Iteration 2");
		expect(result).toContain("Did B");
	});

	test("uses custom start iteration", () => {
		const result = formatProgressHistory(["Did C"], 5);
		expect(result).toContain("### Iteration 5");
		expect(result).toContain("Did C");
	});
});

// ── formatDelegationResults ─────────────────────────────────

describe("formatDelegationResults", () => {
	test("formats delegation results", () => {
		const result = formatDelegationResults([
			{
				jobId: "xyz",
				task: "Run tests",
				status: "complete",
				summary: "All tests pass",
				filesChanged: ["a.ts", "b.ts"],
				duration: 30,
			},
		]);
		expect(result).toContain("### Task: Run tests");
		expect(result).toContain("Status: complete");
		expect(result).toContain("Job: xyz");
		expect(result).toContain("Duration: 30s");
		expect(result).toContain("a.ts, b.ts");
		expect(result).toContain("All tests pass");
	});

	test("shows error when present", () => {
		const result = formatDelegationResults([
			{
				jobId: "err",
				task: "Broken task",
				status: "failed",
				summary: "",
				filesChanged: [],
				duration: 5,
				error: "Process crashed",
			},
		]);
		expect(result).toContain("Error: Process crashed");
	});
});

// ── buildProtocolSection ────────────────────────────────────

describe("buildProtocolSection", () => {
	test("contains all protocol elements", () => {
		const result = buildProtocolSection();
		expect(result).toContain("## Randal Execution Protocol");
		expect(result).toContain("### Task Plan");
		expect(result).toContain("### Progress Summary");
		expect(result).toContain("### Delegation");
		expect(result).toContain("### Completion");
		expect(result).toContain("<plan-update>");
		expect(result).toContain("<progress>");
		expect(result).toContain("<delegate>");
		expect(result).toContain("<promise>DONE</promise>");
	});
});
