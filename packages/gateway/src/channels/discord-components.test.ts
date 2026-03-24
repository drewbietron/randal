import { describe, expect, test } from "bun:test";
import type { Job } from "@randal/core";
import {
	SLASH_COMMANDS,
	buildCompletionButtons,
	buildContextModal,
	buildCustomCommand,
	buildCustomCommandPrompt,
	buildDashboardEmbed,
	buildDashboardRefreshButton,
	buildDisabledProgressButtons,
	buildFailureButtons,
	buildJobEmbed,
	buildJobSelectMenu,
	buildMemoryModal,
	buildProgressButtons,
	buildThreadName,
	buttonId,
	parseButtonId,
	type DiscordCustomCommandConfig,
} from "./discord-components.js";

// ── Custom ID helpers ────────────────────────────────────────

describe("buttonId / parseButtonId", () => {
	test("creates ID with action and jobId", () => {
		expect(buttonId("stop", "abc123")).toBe("randal:stop:abc123");
	});

	test("creates ID with action only", () => {
		expect(buttonId("dashboard_refresh")).toBe("randal:dashboard_refresh");
	});

	test("parses action + jobId", () => {
		const result = parseButtonId("randal:stop:abc123");
		expect(result).toEqual({ action: "stop", jobId: "abc123" });
	});

	test("parses action only", () => {
		const result = parseButtonId("randal:dashboard_refresh");
		expect(result).toEqual({ action: "dashboard_refresh" });
	});

	test("returns null for non-randal IDs", () => {
		expect(parseButtonId("other:action:id")).toBeNull();
	});

	test("handles jobId with colons", () => {
		const result = parseButtonId("randal:stop:abc:123");
		expect(result).toEqual({ action: "stop", jobId: "abc:123" });
	});
});

// ── Button builders ──────────────────────────────────────────

describe("buildProgressButtons", () => {
	test("creates row with stop, inject context, and details buttons", () => {
		const row = buildProgressButtons("job-1");
		const data = row.toJSON();
		expect(data.components).toHaveLength(3);

		const labels = data.components.map((c: { label: string }) => c.label);
		expect(labels).toEqual(["Stop", "Inject Context", "Details"]);
	});

	test("buttons have correct custom IDs", () => {
		const row = buildProgressButtons("job-1");
		const ids = row.toJSON().components.map((c: { custom_id: string }) => c.custom_id);
		expect(ids).toEqual([
			"randal:stop:job-1",
			"randal:context:job-1",
			"randal:details:job-1",
		]);
	});
});

describe("buildCompletionButtons", () => {
	test("creates row with retry and save to memory buttons", () => {
		const row = buildCompletionButtons("job-1");
		const labels = row.toJSON().components.map((c: { label: string }) => c.label);
		expect(labels).toEqual(["Retry", "Save to Memory"]);
	});
});

describe("buildFailureButtons", () => {
	test("creates row with retry, resume, and details buttons", () => {
		const row = buildFailureButtons("job-1");
		const labels = row.toJSON().components.map((c: { label: string }) => c.label);
		expect(labels).toEqual(["Retry", "Resume", "Details"]);
	});
});

describe("buildDisabledProgressButtons", () => {
	test("stop and context buttons are disabled, details is enabled", () => {
		const row = buildDisabledProgressButtons("job-1");
		const components = row.toJSON().components;
		// Stop — disabled
		expect(components[0].disabled).toBe(true);
		// Inject Context — disabled
		expect(components[1].disabled).toBe(true);
		// Details — NOT disabled (undefined or false)
		expect(components[2].disabled).toBeFalsy();
	});
});

describe("buildDashboardRefreshButton", () => {
	test("creates single refresh button", () => {
		const row = buildDashboardRefreshButton();
		const data = row.toJSON();
		expect(data.components).toHaveLength(1);
		expect(data.components[0].label).toBe("Refresh");
	});
});

// ── Job select menu ──────────────────────────────────────────

describe("buildJobSelectMenu", () => {
	const jobs = [
		makeJob({ id: "job-1", status: "running", prompt: "Deploy auth fix" }),
		makeJob({ id: "job-2", status: "complete", prompt: "Write tests" }),
	];

	test("creates select menu with correct jobs", () => {
		const row = buildJobSelectMenu(jobs, "details");
		const menu = row.toJSON().components[0];
		expect(menu.options).toHaveLength(2);
	});

	test("limits to 25 options", () => {
		const manyJobs = Array.from({ length: 30 }, (_, i) =>
			makeJob({ id: `job-${i}`, prompt: `Task ${i}` }),
		);
		const row = buildJobSelectMenu(manyJobs, "stop");
		expect(row.toJSON().components[0].options).toHaveLength(25);
	});
});

// ── Embed builders ───────────────────────────────────────────

describe("buildJobEmbed", () => {
	test("creates embed with correct title and fields", () => {
		const job = makeJob({ id: "abc123", status: "running", prompt: "Deploy something" });
		const embed = buildJobEmbed(job);
		const data = embed.toJSON();
		expect(data.title).toContain("abc123");
		expect(data.description).toBe("Deploy something");
		expect(data.fields?.some((f) => f.name === "Status" && f.value === "running")).toBe(true);
	});

	test("includes plan if present", () => {
		const job = makeJob({
			plan: [
				{ task: "Step 1", status: "completed" },
				{ task: "Step 2", status: "in_progress" },
			],
		});
		const data = buildJobEmbed(job).toJSON();
		expect(data.fields?.some((f) => f.name === "Plan")).toBe(true);
	});

	test("includes error if present", () => {
		const job = makeJob({ status: "failed", error: "Out of memory" });
		const data = buildJobEmbed(job).toJSON();
		expect(data.fields?.some((f) => f.name === "Error" && f.value?.includes("Out of memory"))).toBe(true);
	});
});

describe("buildDashboardEmbed", () => {
	test("creates embed with active and recent job sections", () => {
		const embed = buildDashboardEmbed({
			activeJobs: [makeJob({ id: "a1", status: "running" })],
			recentJobs: [makeJob({ id: "r1", status: "complete" })],
			memoryCount: 42,
		});
		const data = embed.toJSON();
		expect(data.title).toContain("Dashboard");
		expect(data.fields?.some((f) => f.name.includes("Active"))).toBe(true);
		expect(data.fields?.some((f) => f.name.includes("Recent"))).toBe(true);
		expect(data.footer?.text).toContain("42");
	});

	test("shows 'None' when no active jobs", () => {
		const embed = buildDashboardEmbed({ activeJobs: [], recentJobs: [] });
		const data = embed.toJSON();
		expect(data.fields?.some((f) => f.value === "None")).toBe(true);
	});
});

// ── Modal builders ───────────────────────────────────────────

describe("buildContextModal", () => {
	test("creates modal with context text input", () => {
		const modal = buildContextModal("job-1");
		const data = modal.toJSON();
		expect(data.custom_id).toBe("randal:modal_context:job-1");
		expect(data.title).toBe("Inject Context");
		expect(data.components).toHaveLength(1);
	});
});

describe("buildMemoryModal", () => {
	test("creates modal with text and category inputs", () => {
		const modal = buildMemoryModal();
		const data = modal.toJSON();
		expect(data.custom_id).toBe("randal:modal_memory");
		expect(data.components).toHaveLength(2);
	});

	test("pre-fills default text", () => {
		const modal = buildMemoryModal("Some default text");
		const data = modal.toJSON();
		const textInput = data.components[0].components[0];
		expect(textInput.value).toBe("Some default text");
	});
});

// ── Slash commands ───────────────────────────────────────────

describe("SLASH_COMMANDS", () => {
	test("defines expected commands", () => {
		const names = SLASH_COMMANDS.map((cmd) => cmd.toJSON().name);
		expect(names).toContain("run");
		expect(names).toContain("status");
		expect(names).toContain("jobs");
		expect(names).toContain("stop");
		expect(names).toContain("resume");
		expect(names).toContain("memory");
		expect(names).toContain("dashboard");
	});

	test("run command has required prompt option", () => {
		const run = SLASH_COMMANDS.find((c) => c.toJSON().name === "run")!.toJSON();
		expect(run.options?.[0]?.name).toBe("prompt");
		expect(run.options?.[0]?.required).toBe(true);
	});

	test("memory command has search and add subcommands", () => {
		const mem = SLASH_COMMANDS.find((c) => c.toJSON().name === "memory")!.toJSON();
		const subNames = mem.options?.map((o: { name: string }) => o.name);
		expect(subNames).toContain("search");
		expect(subNames).toContain("add");
	});
});

// ── Thread name lifecycle ────────────────────────────────────

describe("buildThreadName", () => {
	test("creates started name with emoji", () => {
		const name = buildThreadName({ state: "started", topic: "Deploy auth fix" });
		expect(name).toContain("🔄");
		expect(name).toContain("Deploy auth fix");
	});

	test("creates running name with iteration count", () => {
		const name = buildThreadName({
			state: "running",
			topic: "Deploy auth fix",
			iteration: 3,
			maxIterations: 10,
		});
		expect(name).toContain("🔄");
		expect(name).toContain("[3/10]");
	});

	test("creates complete name with checkmark", () => {
		const name = buildThreadName({ state: "complete", topic: "Deployed auth fix" });
		expect(name).toContain("✅");
		expect(name).toContain("Deployed auth fix");
	});

	test("creates failed name with X", () => {
		const name = buildThreadName({ state: "failed", topic: "Deploy failed" });
		expect(name).toContain("❌");
	});

	test("creates stopped name with pause", () => {
		const name = buildThreadName({ state: "stopped", topic: "Deploy paused" });
		expect(name).toContain("⏸️");
	});

	test("truncates long topics to fit 100 char limit", () => {
		const longTopic = "A".repeat(200);
		const name = buildThreadName({ state: "started", topic: longTopic });
		expect(name.length).toBeLessThanOrEqual(100);
	});

	test("does not show iteration prefix for iteration 1", () => {
		const name = buildThreadName({
			state: "running",
			topic: "Task",
			iteration: 1,
			maxIterations: 5,
		});
		// Iteration 1 should use time prefix, not [1/5]
		expect(name).not.toContain("[1/5]");
	});
});

// ── Custom command builders ──────────────────────────────────

describe("buildCustomCommand", () => {
	test("creates command with no options", () => {
		const cmd: DiscordCustomCommandConfig = {
			name: "deploy",
			description: "Deploy a service",
			options: [],
		};
		const builder = buildCustomCommand(cmd);
		const data = builder.toJSON();
		expect(data.name).toBe("deploy");
		expect(data.description).toBe("Deploy a service");
		expect(data.options).toHaveLength(0);
	});

	test("creates command with string option and choices", () => {
		const cmd: DiscordCustomCommandConfig = {
			name: "deploy",
			description: "Deploy a service",
			options: [
				{
					name: "service",
					description: "Which service",
					type: "string",
					required: true,
					choices: ["api", "web", "worker"],
				},
			],
		};
		const builder = buildCustomCommand(cmd);
		const data = builder.toJSON();
		expect(data.options).toHaveLength(1);
		expect(data.options![0].name).toBe("service");
		expect(data.options![0].required).toBe(true);
		// Choices should be mapped to {name, value} objects
		expect((data.options![0] as { choices: Array<{ name: string; value: string }> }).choices).toEqual([
			{ name: "api", value: "api" },
			{ name: "web", value: "web" },
			{ name: "worker", value: "worker" },
		]);
	});

	test("creates command with integer option", () => {
		const cmd: DiscordCustomCommandConfig = {
			name: "scale",
			description: "Scale a service",
			options: [
				{ name: "replicas", description: "Number of replicas", type: "integer", required: true },
			],
		};
		const builder = buildCustomCommand(cmd);
		const data = builder.toJSON();
		expect(data.options).toHaveLength(1);
		expect(data.options![0].name).toBe("replicas");
	});

	test("creates command with boolean option", () => {
		const cmd: DiscordCustomCommandConfig = {
			name: "deploy",
			description: "Deploy a service",
			options: [
				{ name: "force", description: "Force deploy", type: "boolean", required: false },
			],
		};
		const builder = buildCustomCommand(cmd);
		const data = builder.toJSON();
		expect(data.options).toHaveLength(1);
		expect(data.options![0].name).toBe("force");
	});

	test("creates command with number option", () => {
		const cmd: DiscordCustomCommandConfig = {
			name: "threshold",
			description: "Set threshold",
			options: [
				{ name: "value", description: "Threshold value", type: "number", required: true },
			],
		};
		const builder = buildCustomCommand(cmd);
		const data = builder.toJSON();
		expect(data.options).toHaveLength(1);
		expect(data.options![0].name).toBe("value");
	});

	test("creates command with multiple options", () => {
		const cmd: DiscordCustomCommandConfig = {
			name: "deploy",
			description: "Deploy a service",
			options: [
				{ name: "service", description: "Which service", type: "string", required: true, choices: ["api", "web"] },
				{ name: "env", description: "Environment", type: "string", required: false, choices: ["staging", "production"] },
				{ name: "force", description: "Force", type: "boolean", required: false },
			],
		};
		const builder = buildCustomCommand(cmd);
		const data = builder.toJSON();
		expect(data.options).toHaveLength(3);
	});
});

describe("buildCustomCommandPrompt", () => {
	test("builds prompt with command name only", () => {
		const prompt = buildCustomCommandPrompt("deploy", []);
		expect(prompt).toContain("## Command");
		expect(prompt).toContain("deploy");
	});

	test("builds prompt with options", () => {
		const prompt = buildCustomCommandPrompt("deploy", [
			{ name: "service", value: "api" },
			{ name: "env", value: "production" },
		]);
		expect(prompt).toContain("deploy");
		expect(prompt).toContain("service: api");
		expect(prompt).toContain("env: production");
	});

	test("builds prompt with instructions", () => {
		const prompt = buildCustomCommandPrompt(
			"deploy",
			[{ name: "service", value: "api" }],
			"You are a DevOps assistant",
		);
		expect(prompt).toContain("## Instructions");
		expect(prompt).toContain("You are a DevOps assistant");
		expect(prompt).toContain("## Command");
		expect(prompt).toContain("deploy");
	});

	test("omits instructions section when not provided", () => {
		const prompt = buildCustomCommandPrompt("deploy", []);
		expect(prompt).not.toContain("## Instructions");
	});
});

// ── Test helpers ─────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
	return {
		id: "test-job",
		status: "running",
		prompt: "Test prompt",
		agent: "opencode",
		model: "anthropic/claude-sonnet-4",
		maxIterations: 10,
		workdir: "/tmp/test",
		createdAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		completedAt: null,
		duration: null,
		iterations: { current: 1, history: [] },
		plan: [],
		progressHistory: [],
		delegations: [],
		cost: { totalTokens: { input: 0, output: 0 }, estimatedCost: 0, wallTime: 0 },
		updates: [],
		error: null,
		exitCode: null,
		...overrides,
	};
}
