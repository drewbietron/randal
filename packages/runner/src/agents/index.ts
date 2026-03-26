import type { AgentAdapter } from "./adapter.js";
import { mock } from "./mock.js";
import { opencode } from "./opencode.js";

export type { AgentAdapter, RunOpts } from "./adapter.js";

const adapters: Record<string, AgentAdapter> = {
	opencode,
	mock,
};

/**
 * Get an agent adapter by name.
 * Throws if the adapter is not found.
 */
export function getAdapter(name: string): AgentAdapter {
	const adapter = adapters[name];
	if (!adapter) {
		throw new Error(
			`Unknown agent adapter: "${name}". Available: ${Object.keys(adapters).join(", ")}`,
		);
	}
	return adapter;
}

/**
 * Register a custom agent adapter.
 */
export function registerAdapter(name: string, adapter: AgentAdapter): void {
	adapters[name] = adapter;
}

export { opencode } from "./opencode.js";
export { mock } from "./mock.js";
