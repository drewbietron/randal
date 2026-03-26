import { describe, expect, test } from "bun:test";
import { parseDelegationRequests, parsePlanUpdate, parseProgress } from "./plan-parser.js";

// ── parsePlanUpdate ─────────────────────────────────────────

describe("parsePlanUpdate", () => {
	test("parses valid plan-update tag", () => {
		const output = `Some text
<plan-update>
[
  {"task": "Set up database schema", "status": "completed"},
  {"task": "Implement API endpoints", "status": "in_progress"},
  {"task": "Write integration tests", "status": "pending"}
]
</plan-update>
More text`;

		const result = parsePlanUpdate(output);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(3);
		expect(result?.[0]).toEqual({ task: "Set up database schema", status: "completed" });
		expect(result?.[1]).toEqual({ task: "Implement API endpoints", status: "in_progress" });
		expect(result?.[2]).toEqual({ task: "Write integration tests", status: "pending" });
	});

	test("returns null when no plan-update tag exists", () => {
		const output = "Just some regular agent output without any tags";
		expect(parsePlanUpdate(output)).toBeNull();
	});

	test("uses last plan-update when multiple exist", () => {
		const output = `
<plan-update>
[{"task": "Old task", "status": "pending"}]
</plan-update>
Some work...
<plan-update>
[{"task": "New task", "status": "completed"}]
</plan-update>`;

		const result = parsePlanUpdate(output);
		expect(result).toHaveLength(1);
		expect(result?.[0].task).toBe("New task");
		expect(result?.[0].status).toBe("completed");
	});

	test("returns null for malformed JSON", () => {
		const output = "<plan-update>not valid json</plan-update>";
		expect(parsePlanUpdate(output)).toBeNull();
	});

	test("returns null for non-array JSON", () => {
		const output = '<plan-update>{"task": "single", "status": "pending"}</plan-update>';
		expect(parsePlanUpdate(output)).toBeNull();
	});

	test("skips invalid entries but keeps valid ones", () => {
		const output = `<plan-update>
[
  {"task": "Valid task", "status": "pending"},
  {"task": "", "status": "pending"},
  {"status": "completed"},
  {"task": "Another valid", "status": "completed"}
]
</plan-update>`;

		const result = parsePlanUpdate(output);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(2);
		expect(result?.[0].task).toBe("Valid task");
		expect(result?.[1].task).toBe("Another valid");
	});

	test("returns null when all entries are invalid", () => {
		const output = `<plan-update>
[{"task": "", "status": "invalid"}]
</plan-update>`;
		expect(parsePlanUpdate(output)).toBeNull();
	});

	test("handles failed status", () => {
		const output = `<plan-update>
[{"task": "Broken task", "status": "failed"}]
</plan-update>`;

		const result = parsePlanUpdate(output);
		expect(result).not.toBeNull();
		expect(result?.[0].status).toBe("failed");
	});

	test("rejects invalid status values", () => {
		const output = `<plan-update>
[{"task": "Task", "status": "done"}]
</plan-update>`;
		expect(parsePlanUpdate(output)).toBeNull();
	});
});

// ── parseProgress ───────────────────────────────────────────

describe("parseProgress", () => {
	test("parses valid progress tag", () => {
		const output = `Working on things...
<progress>
Completed the database schema with User and Post models.
API endpoint for /users is implemented and passing tests.
Next: implement the /posts endpoint.
</progress>`;

		const result = parseProgress(output);
		expect(result).not.toBeNull();
		expect(result).toContain("Completed the database schema");
		expect(result).toContain("Next: implement the /posts endpoint.");
	});

	test("returns null when no progress tag exists", () => {
		expect(parseProgress("No tags here")).toBeNull();
	});

	test("uses last progress tag when multiple exist", () => {
		const output = `
<progress>First progress</progress>
More work...
<progress>Second progress</progress>`;

		const result = parseProgress(output);
		expect(result).toBe("Second progress");
	});

	test("returns null for empty progress tag", () => {
		const output = "<progress>   </progress>";
		// After trim, empty string returns null
		expect(parseProgress(output)).toBeNull();
	});
});

// ── parseDelegationRequests ─────────────────────────────────

describe("parseDelegationRequests", () => {
	test("parses valid delegation request", () => {
		const output = `I'll delegate this task.
<delegate>
{
  "task": "Write unit tests for the User model",
  "context": "User model at src/models/user.ts with fields: id, name, email",
  "maxIterations": 5
}
</delegate>`;

		const result = parseDelegationRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].task).toBe("Write unit tests for the User model");
		expect(result[0].context).toContain("User model at");
		expect(result[0].maxIterations).toBe(5);
	});

	test("returns empty array when no delegate tags exist", () => {
		expect(parseDelegationRequests("No delegation here")).toHaveLength(0);
	});

	test("parses multiple delegation requests", () => {
		const output = `
<delegate>{"task": "Task A", "context": "Context A"}</delegate>
<delegate>{"task": "Task B"}</delegate>
<delegate>{"task": "Task C", "maxIterations": 3}</delegate>`;

		const result = parseDelegationRequests(output);
		expect(result).toHaveLength(3);
		expect(result[0].task).toBe("Task A");
		expect(result[1].task).toBe("Task B");
		expect(result[2].maxIterations).toBe(3);
	});

	test("skips invalid delegation requests", () => {
		const output = `
<delegate>{"task": "Valid task"}</delegate>
<delegate>not json</delegate>
<delegate>{"task": ""}</delegate>
<delegate>{"task": "Also valid", "agent": "opencode"}</delegate>`;

		const result = parseDelegationRequests(output);
		expect(result).toHaveLength(2);
		expect(result[0].task).toBe("Valid task");
		expect(result[1].task).toBe("Also valid");
		expect(result[1].agent).toBe("opencode");
	});

	test("handles optional fields correctly", () => {
		const output = `<delegate>
{
  "task": "Test task",
  "agent": "opencode",
  "model": "gpt-4",
  "maxIterations": 10
}
</delegate>`;

		const result = parseDelegationRequests(output);
		expect(result).toHaveLength(1);
		expect(result[0].agent).toBe("opencode");
		expect(result[0].model).toBe("gpt-4");
		expect(result[0].maxIterations).toBe(10);
	});

	test("rejects negative maxIterations", () => {
		const output = '<delegate>{"task": "Bad iterations", "maxIterations": -1}</delegate>';
		const result = parseDelegationRequests(output);
		expect(result).toHaveLength(0);
	});
});
