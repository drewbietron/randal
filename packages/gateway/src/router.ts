/**
 * Prefix command router.
 * Parses messages in the format "command: args" for channel integration.
 */

export interface ParsedCommand {
	command: string;
	args: string;
}

const COMMANDS = ["run", "status", "stop", "context", "jobs", "memory", "resume", "help"];

/**
 * Parse a prefix command from a message string.
 * Returns null if the message is not a recognized command.
 */
export function parseCommand(message: string): ParsedCommand | null {
	const trimmed = message.trim();

	// Check for commands with colon syntax: "command: args"
	for (const cmd of COMMANDS) {
		if (trimmed.toLowerCase().startsWith(`${cmd}:`)) {
			return {
				command: cmd,
				args: trimmed.slice(cmd.length + 1).trim(),
			};
		}
		// Also check for bare commands (no colon): "status", "jobs", "help"
		if (trimmed.toLowerCase() === cmd) {
			return { command: cmd, args: "" };
		}
	}

	return null;
}

/**
 * Format a help response listing available commands.
 */
export function formatHelp(): string {
	return `Available commands:
  run: <prompt>       - Start a new job
  run: file:<path>    - Start job from spec file
  status              - Current job status
  status: <id>        - Specific job status
  stop                - Stop current job
  stop: <id>          - Stop specific job
  context: <text>     - Inject context into running job
  jobs                - List all jobs
  memory: <query>     - Search memory
  resume: <id>        - Resume a failed job
  help                - Show this help`;
}
