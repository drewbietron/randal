import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONTEXT_FILENAME = "context.md";

/**
 * Get the path to the context file for a job.
 */
export function contextFilePath(jobWorkdir: string): string {
	return join(jobWorkdir, CONTEXT_FILENAME);
}

/**
 * Read injected context from the context file.
 * Returns the content and deletes the file.
 * Returns null if no context file exists.
 */
export function readAndClearContext(jobWorkdir: string): string | null {
	const path = contextFilePath(jobWorkdir);
	if (!existsSync(path)) return null;

	try {
		const content = readFileSync(path, "utf-8").trim();
		unlinkSync(path);
		return content || null;
	} catch {
		return null;
	}
}

/**
 * Write context to the context file for a job.
 * Appends to existing context if the file already exists.
 */
export function writeContext(jobWorkdir: string, text: string): void {
	const path = contextFilePath(jobWorkdir);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	let existing = "";
	if (existsSync(path)) {
		existing = readFileSync(path, "utf-8");
		if (existing && !existing.endsWith("\n")) {
			existing += "\n";
		}
	}

	writeFileSync(path, `${existing + text}\n`, "utf-8");
}

/**
 * Check if context is pending for a job.
 */
export function hasContext(jobWorkdir: string): boolean {
	return existsSync(contextFilePath(jobWorkdir));
}
