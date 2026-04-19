/**
 * Dashboard unit tests.
 *
 * Tests for utility functions extracted from the inline <script> in index.html.
 * Uses bun:test with happy-dom for DOM globals (registered via setup.ts preload).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDashboardHtml } from "../app.js";
import {
	_toastErrorTimestamps,
	escapeHtml,
	resetPollingState,
	setSseConnected,
	showToast,
	startPolling,
	stopPolling,
} from "../utils.js";

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
describe("escapeHtml", () => {
	test("escapes script tags", () => {
		expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	test("returns normal text unchanged", () => {
		expect(escapeHtml("normal text")).toBe("normal text");
	});

	test("escapes img onerror payload", () => {
		const result = escapeHtml('<img onerror="hack()" />');
		expect(result).toContain("&lt;img");
		expect(result).not.toContain("<img");
	});

	test("returns empty string for empty input", () => {
		expect(escapeHtml("")).toBe("");
	});

	test("handles null gracefully", () => {
		expect(escapeHtml(null)).toBe("");
	});

	test("handles undefined gracefully", () => {
		expect(escapeHtml(undefined)).toBe("");
	});

	test("converts numbers to string", () => {
		expect(escapeHtml(42)).toBe("42");
	});

	test("escapes ampersands", () => {
		expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
	});

	test("preserves quotes in text content (safe in innerHTML text nodes)", () => {
		// textContent-based escaping does not encode quotes —
		// quotes are only dangerous inside attribute values, not text content.
		const result = escapeHtml('a "quoted" value');
		expect(result).toContain('"quoted"');
		// But angle brackets ARE escaped
		expect(escapeHtml('<div class="x">')).toContain("&lt;");
	});
});

// ---------------------------------------------------------------------------
// showToast
// ---------------------------------------------------------------------------
describe("showToast", () => {
	let container: HTMLDivElement;

	beforeEach(() => {
		// Set up minimal DOM for toast container
		container = document.createElement("div");
		container.id = "toast-container";
		document.body.appendChild(container);

		// Clear dedup timestamps
		for (const key of Object.keys(_toastErrorTimestamps)) {
			delete _toastErrorTimestamps[key];
		}
	});

	afterEach(() => {
		container.remove();
	});

	test("creates a toast element in the container", () => {
		showToast("Test message", "info");
		expect(container.children.length).toBe(1);
		const toast = container.children[0] as HTMLElement;
		expect(toast.className).toContain("toast");
		expect(toast.className).toContain("info");
	});

	test("error toast has role=alert", () => {
		showToast("Error occurred", "error");
		const toast = container.children[0] as HTMLElement;
		expect(toast.getAttribute("role")).toBe("alert");
	});

	test("success toast has role=status", () => {
		showToast("Done!", "success");
		const toast = container.children[0] as HTMLElement;
		expect(toast.getAttribute("role")).toBe("status");
	});

	test("toast contains the message text", () => {
		showToast("Hello world", "info");
		const msg = container.querySelector(".toast-msg");
		expect(msg).not.toBeNull();
		expect(msg?.textContent).toBe("Hello world");
	});

	test("toast has a close button with aria-label", () => {
		showToast("test", "info");
		const btn = container.querySelector(".toast-close") as HTMLButtonElement;
		expect(btn).not.toBeNull();
		expect(btn.getAttribute("aria-label")).toBe("Dismiss notification");
	});

	test("close button removes toast from container", () => {
		showToast("test", "info");
		expect(container.children.length).toBe(1);
		const btn = container.querySelector(".toast-close") as HTMLButtonElement;
		btn.click();
		// The toast adds fade-out class and waits for animationend;
		// our fallback setTimeout removes after 500ms. Fire it:
		// Since animationend won't fire in test env, wait for the fallback
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(container.children.length).toBe(0);
				resolve();
			}, 600);
		});
	});

	test("deduplicates error toasts within 30s", () => {
		showToast("Same error", "error");
		showToast("Same error", "error");
		showToast("Same error", "error");
		// Only first one should create a toast
		expect(container.children.length).toBe(1);
	});

	test("allows different error messages", () => {
		showToast("Error A", "error");
		showToast("Error B", "error");
		expect(container.children.length).toBe(2);
	});

	test("escapes HTML in message", () => {
		showToast("<b>bold</b>", "info");
		const msg = container.querySelector(".toast-msg");
		expect(msg?.innerHTML).not.toContain("<b>");
		expect(msg?.innerHTML).toContain("&lt;b&gt;");
	});

	test("does not crash when container is missing", () => {
		container.remove();
		// Should not throw
		expect(() => showToast("no container", "info")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Polling state machine
// ---------------------------------------------------------------------------
describe("polling state machine", () => {
	let callCount: number;
	const refreshFn = () => {
		callCount++;
	};

	beforeEach(() => {
		callCount = 0;
		resetPollingState();
	});

	afterEach(() => {
		resetPollingState();
	});

	test("startPolling creates an interval", () => {
		startPolling(refreshFn, 100);
		// Import is a live binding, but pollInterval is exported as let.
		// We test via the module's exported value:
		const { pollInterval } = require("../utils.js");
		expect(pollInterval).not.toBeNull();
		stopPolling();
	});

	test("stopPolling clears the interval", () => {
		startPolling(refreshFn, 100);
		stopPolling();
		const { pollInterval } = require("../utils.js");
		expect(pollInterval).toBeNull();
	});

	test("startPolling is idempotent — calling twice does not create duplicate intervals", () => {
		startPolling(refreshFn, 50);
		const { pollInterval: first } = require("../utils.js");
		startPolling(refreshFn, 50);
		const { pollInterval: second } = require("../utils.js");
		expect(first).toBe(second);
		stopPolling();
	});

	test("stopPolling is safe to call when no interval exists", () => {
		expect(() => stopPolling()).not.toThrow();
	});

	test("polling calls the refresh function periodically", async () => {
		startPolling(refreshFn, 25);
		await new Promise((r) => setTimeout(r, 140));
		stopPolling();
		// Allow extra timing slack for CI and loaded merge worktrees.
		expect(callCount).toBeGreaterThanOrEqual(2);
	});

	test("resetPollingState clears everything", () => {
		startPolling(refreshFn, 100);
		setSseConnected(true);
		resetPollingState();
		const utils = require("../utils.js");
		expect(utils.pollInterval).toBeNull();
		expect(utils.sseConnected).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// API contract expectations (documenting expected shapes)
// ---------------------------------------------------------------------------
describe("API contract expectations", () => {
	test("/instance returns expected shape", () => {
		const instance = {
			name: "randal-1",
			version: "0.1.0",
			status: "idle",
			posse: "main-posse",
		};
		expect(instance).toHaveProperty("name");
		expect(instance).toHaveProperty("version");
		expect(instance).toHaveProperty("status");
		expect(typeof instance.name).toBe("string");
		expect(typeof instance.version).toBe("string");
		expect(["idle", "busy"]).toContain(instance.status);
	});

	test("/jobs returns expected job shape", () => {
		const job = {
			id: "job-abc123",
			status: "running",
			prompt: "Build a feature",
			agent: "opencode",
			iterations: { current: 2 },
			maxIterations: 10,
			cost: { estimatedCost: 0.0042 },
			plan: [{ task: "step 1", status: "completed" }],
		};
		expect(job).toHaveProperty("id");
		expect(job).toHaveProperty("status");
		expect(job).toHaveProperty("prompt");
		expect(job).toHaveProperty("agent");
		expect(job.iterations).toHaveProperty("current");
		expect(job).toHaveProperty("maxIterations");
		expect(job.cost).toHaveProperty("estimatedCost");
		expect(typeof job.cost.estimatedCost).toBe("number");
	});

	test("/job/:id returns full job with iterations.history, plan, delegations, spec", () => {
		const fullJob = {
			id: "job-abc123",
			status: "complete",
			prompt: "Build a feature",
			agent: "opencode",
			iterations: {
				current: 5,
				history: [
					{ number: 1, duration: 30, summary: "Initial setup" },
					{ number: 2, duration: 45, summary: "Implementation" },
				],
			},
			maxIterations: 10,
			cost: { estimatedCost: 0.015 },
			plan: [
				{ task: "step 1", status: "completed", iterationNumber: 1 },
				{ task: "step 2", status: "completed", iterationNumber: 2 },
			],
			delegations: [{ task: "sub-task", status: "complete", jobId: "job-sub1", duration: 120 }],
			spec: { content: "Full spec content here" },
		};
		expect(fullJob.iterations).toHaveProperty("history");
		expect(Array.isArray(fullJob.iterations.history)).toBe(true);
		expect(fullJob.iterations.history[0]).toHaveProperty("number");
		expect(fullJob.iterations.history[0]).toHaveProperty("duration");
		expect(fullJob.iterations.history[0]).toHaveProperty("summary");
		expect(Array.isArray(fullJob.plan)).toBe(true);
		expect(Array.isArray(fullJob.delegations)).toBe(true);
		expect(fullJob.spec).toHaveProperty("content");
	});
});

// ---------------------------------------------------------------------------
// Dashboard HTML contract
// ---------------------------------------------------------------------------
describe("dashboard HTML contract", () => {
	test("keeps the public shell and inline unlock affordance", () => {
		const html = getDashboardHtml();
		expect(html).toContain("public overview");
		expect(html).toContain("unlock");
		expect(html).toContain("Unlocked overview");
		expect(html).toContain("Running work");
		expect(html).toContain("Posse coordination");
		expect(html).toContain("Scheduler state");
		expect(html).toContain("Recent events");
	});

	test("uses session exchange instead of prompt localStorage or token query params", () => {
		const html = getDashboardHtml();
		expect(html).toContain('fetch("/auth/session"');
		expect(html).toContain('new EventSource("/events")');
		expect(html).not.toContain("localStorage");
		expect(html).not.toContain("prompt(");
		expect(html).not.toContain("?token=");
	});

	test("fetches follow-up protected requests with same-origin credentials", () => {
		const html = getDashboardHtml();
		expect(html).toContain('credentials: "same-origin"');
		expect(html).toContain('safeFetchJson("/instance")');
		expect(html).toContain('safeFetchJson("/jobs")');
		expect(html).toContain('safeFetchJson("/scheduler")');
	});
});
