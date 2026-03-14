export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface LogEntry {
	level: LogLevel;
	msg: string;
	ts: string;
	[key: string]: unknown;
}

export interface Logger {
	debug(msg: string, data?: Record<string, unknown>): void;
	info(msg: string, data?: Record<string, unknown>): void;
	warn(msg: string, data?: Record<string, unknown>): void;
	error(msg: string, data?: Record<string, unknown>): void;
	child(context: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
	level?: LogLevel;
	output?: (entry: LogEntry) => void;
	context?: Record<string, unknown>;
}

function defaultOutput(entry: LogEntry): void {
	const line = JSON.stringify(entry);
	if (entry.level === "error") {
		console.error(line);
	} else if (entry.level === "warn") {
		console.warn(line);
	} else {
		console.log(line);
	}
}

export function createLogger(options: LoggerOptions = {}): Logger {
	const minLevel = LOG_LEVELS[options.level ?? "info"];
	const output = options.output ?? defaultOutput;
	const context = options.context ?? {};

	function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
		if (LOG_LEVELS[level] < minLevel) return;

		const entry: LogEntry = {
			level,
			msg,
			ts: new Date().toISOString(),
			...context,
			...data,
		};

		output(entry);
	}

	return {
		debug: (msg, data) => log("debug", msg, data),
		info: (msg, data) => log("info", msg, data),
		warn: (msg, data) => log("warn", msg, data),
		error: (msg, data) => log("error", msg, data),
		child(childContext) {
			return createLogger({
				level: options.level,
				output,
				context: { ...context, ...childContext },
			});
		},
	};
}
