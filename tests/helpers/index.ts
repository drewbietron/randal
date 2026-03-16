import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Annotation, MeshInstance, RunnerEvent } from "@randal/core";
import { parseConfig } from "@randal/core";
import YAML from "yaml";

/**
 * Create a minimal valid RandalConfig, merging any overrides.
 */
export function makeConfig(overrides: Record<string, unknown> = {}) {
	const base: Record<string, unknown> = {
		name: "test-agent",
		runner: { workdir: "/tmp/test" },
		...overrides,
	};
	const yamlStr = YAML.stringify(base);
	return parseConfig(yamlStr);
}

/**
 * Create a temp directory for test isolation.
 * Returns `{ dir, cleanup }` — call `cleanup()` in afterEach.
 */
export function makeTmpDir() {
	const dir = mkdtempSync(join(tmpdir(), "randal-test-"));
	const cleanup = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	};
	return { dir, cleanup };
}

/**
 * Create a test Annotation with sensible defaults.
 */
export function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
	return {
		id: `ann-${Math.random().toString(36).slice(2, 10)}`,
		jobId: `job-${Math.random().toString(36).slice(2, 10)}`,
		verdict: "pass",
		agent: "opencode",
		model: "anthropic/claude-sonnet-4",
		domain: "backend",
		iterationCount: 3,
		tokenCost: 15000,
		duration: 120,
		filesChanged: ["src/index.ts"],
		prompt: "build the API",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

/**
 * Create a test MeshInstance with sensible defaults.
 */
export function makeInstance(overrides: Partial<MeshInstance> = {}): MeshInstance {
	return {
		instanceId: `inst-${Math.random().toString(36).slice(2, 10)}`,
		name: "test-instance",
		posse: "test-posse",
		capabilities: ["run", "delegate"],
		specialization: undefined,
		status: "idle",
		lastHeartbeat: new Date().toISOString(),
		endpoint: "http://localhost:3000",
		models: ["anthropic/claude-sonnet-4"],
		activeJobs: 0,
		completedJobs: 0,
		health: { uptime: 1000, missedPings: 0 },
		...overrides,
	};
}

/**
 * Create a mock EventBus for testing channel adapters.
 */
export function makeMockEventBus() {
	const handlers: Array<(event: RunnerEvent) => void> = [];
	return {
		subscribe(handler: (event: RunnerEvent) => void) {
			handlers.push(handler);
			return () => {
				const idx = handlers.indexOf(handler);
				if (idx >= 0) handlers.splice(idx, 1);
			};
		},
		emit(event: RunnerEvent) {
			for (const handler of handlers) {
				handler(event);
			}
		},
		get subscriberCount() {
			return handlers.length;
		},
		/** Expose handlers for test inspection */
		_handlers: handlers,
	};
}
