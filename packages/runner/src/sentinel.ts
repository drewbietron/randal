import { randomBytes } from "node:crypto";

/**
 * Generate a unique sentinel token (8-char hex).
 */
export function generateToken(): string {
	return randomBytes(4).toString("hex");
}

/**
 * Build the sentinel-wrapped command string.
 * Wraps the agent command with start/done markers for reliable
 * output capture and exit code detection.
 */
export function wrapCommand(token: string, command: string, args: string[]): { shell: string } {
	const escaped = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
	const shell = `echo "__START_${token}" ; ${command} ${escaped} ; echo "__DONE_${token}:$?"`;
	return { shell };
}

/**
 * Check if a line contains the start marker.
 */
export function isStartMarker(line: string, token: string): boolean {
	return line.trim() === `__START_${token}`;
}

/**
 * Check if a line contains the done marker and extract the exit code.
 * Returns null if not a done marker.
 */
export function parseDoneMarker(line: string, token: string): { exitCode: number } | null {
	const prefix = `__DONE_${token}:`;
	const trimmed = line.trim();
	if (!trimmed.startsWith(prefix)) return null;

	const codeStr = trimmed.slice(prefix.length);
	const exitCode = Number.parseInt(codeStr, 10);
	if (Number.isNaN(exitCode)) return null;

	return { exitCode };
}

/**
 * Check if output contains a completion promise.
 */
export function findCompletionPromise(output: string, promiseTag: string): boolean {
	return output.includes(`<promise>${promiseTag}</promise>`);
}

/**
 * Parse all output between sentinel markers.
 * Returns the agent output and exit code.
 */
export function parseOutput(
	fullOutput: string,
	token: string,
): { output: string; exitCode: number } | null {
	const startMarker = `__START_${token}`;
	const donePrefix = `__DONE_${token}:`;

	const startIdx = fullOutput.indexOf(startMarker);
	if (startIdx === -1) return null;

	const doneIdx = fullOutput.indexOf(donePrefix);
	if (doneIdx === -1) return null;

	const output = fullOutput.slice(startIdx + startMarker.length, doneIdx).trim();

	const afterDone = fullOutput.slice(doneIdx + donePrefix.length);
	const exitCodeStr = afterDone.split("\n")[0].trim();
	const exitCode = Number.parseInt(exitCodeStr, 10);

	return {
		output,
		exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
	};
}
