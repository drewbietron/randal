import { rename } from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

/**
 * Resolve the main worktree root directory.
 *
 * When called from a linked worktree, `context.worktree` points to that
 * worktree — but loop-state must always live in the MAIN worktree's
 * `.opencode/`. We use `git rev-parse --git-common-dir` to find the shared
 * `.git` directory and derive the main worktree root from it.
 */
async function mainWorktreeRoot(cwd: string): Promise<string> {
	try {
		const result =
			await Bun.$`git -C ${cwd} rev-parse --path-format=absolute --git-common-dir`.text();
		const gitCommonDir = result.trim(); // e.g. /Users/x/repo/.git
		// The main worktree root is the parent of the .git directory
		if (gitCommonDir.endsWith("/.git")) {
			return gitCommonDir.slice(0, -5);
		}
		// Bare repo or unexpected layout — fall back to cwd
		return cwd;
	} catch {
		// Not a git repo — fall back to cwd
		return cwd;
	}
}

const readTool = tool({
	description:
		"Read the current loop state from .opencode/loop-state.json. Returns all active, paused, errored, and completed builds.",
	args: {},
	async execute(_args, context) {
		const root = await mainWorktreeRoot(context.worktree);
		const file = path.join(root, ".opencode", "loop-state.json");
		try {
			const content = await Bun.file(file).text();
			return content;
		} catch {
			return JSON.stringify({ version: 1, builds: {} }, null, 2);
		}
	},
});

const writeTool = tool({
	description:
		"Update the loop state in .opencode/loop-state.json. Pass the full builds object. Use this to track active builds, record progress, mark completion, or log errors.",
	args: {
		builds: tool.schema.string().describe("JSON string of the full builds object to write"),
	},
	async execute(args, context) {
		const root = await mainWorktreeRoot(context.worktree);
		const dir = path.join(root, ".opencode");
		const file = path.join(dir, "loop-state.json");
		const tmpFile = path.join(dir, `loop-state.${Date.now()}.tmp`);

		await Bun.$`mkdir -p ${dir}`;

		const state = { version: 1, builds: JSON.parse(args.builds) };
		// Write to a temp file first, then atomically rename.
		// rename() on the same filesystem is atomic on POSIX, preventing
		// corruption if two builds write concurrently.
		await Bun.write(tmpFile, JSON.stringify(state, null, 2));
		await rename(tmpFile, file);

		return `Loop state saved to ${file}`;
	},
});

export const loop_state_read = readTool;
export const loop_state_write = writeTool;
