/**
 * Lightweight arg parsing utility for CLI commands.
 *
 * Replaces hand-rolled `for` loops with a declarative spec.
 * Collects unknown flags and suggests corrections via Levenshtein distance.
 */

export interface ArgSpec {
	/** Flags that take a string value: --agent <value> */
	string?: string[];
	/** Flags that take a number value: --max-iterations <value> */
	number?: string[];
	/** Boolean flags: --verbose, -v */
	boolean?: string[];
	/** Aliases: { "-v": "--verbose" } */
	aliases?: Record<string, string>;
	/** Flags to silently skip (global flags already handled upstream) */
	passthrough?: string[];
}

export interface ParsedArgs {
	/** Named flag values keyed by long flag name (without --) */
	flags: Record<string, string | number | boolean>;
	/** Positional arguments (non-flag values) */
	positionals: string[];
	/** Unknown flags encountered */
	unknown: string[];
}

/**
 * Compute Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1]
					: 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}
	return dp[m][n];
}

/**
 * Suggest the closest known flag for a misspelled flag (Levenshtein distance ≤ 2).
 */
function suggestFlag(unknown: string, known: string[]): string | null {
	let best: string | null = null;
	let bestDist = 3; // threshold: only suggest if distance ≤ 2
	for (const flag of known) {
		const dist = levenshtein(unknown, flag);
		if (dist < bestDist) {
			bestDist = dist;
			best = flag;
		}
	}
	return best;
}

/** Strip leading dashes and return the key name */
function flagKey(flag: string): string {
	return flag.replace(/^--?/, "");
}

/**
 * Parse CLI arguments against a declarative spec.
 *
 * - Known flags are parsed into `flags` with correct types.
 * - Unknown `--xxx` flags are collected into `unknown[]`.
 * - After parsing, if `unknown.length > 0`, a warning is printed to stderr
 *   with Levenshtein-based suggestions for close misspellings.
 * - Positional args go into `positionals[]`.
 * - `passthrough` covers global flags like `--config`, `--url` that have
 *   already been consumed upstream — these skip silently without warning.
 */
export function parseArgs(args: string[], spec: ArgSpec): ParsedArgs {
	const stringFlags = new Set(spec.string ?? []);
	const numberFlags = new Set(spec.number ?? []);
	const booleanFlags = new Set(spec.boolean ?? []);
	const aliases = spec.aliases ?? {};
	const passthroughFlags = new Set(spec.passthrough ?? []);

	// Build set of all known long flags (with --)
	const allKnownFlags: string[] = [
		...(spec.string ?? []).map((f) => `--${f}`),
		...(spec.number ?? []).map((f) => `--${f}`),
		...(spec.boolean ?? []).map((f) => `--${f}`),
		...Object.keys(aliases),
		...(spec.passthrough ?? []).map((f) => (f.startsWith("--") ? f : `--${f}`)),
	];

	const flags: Record<string, string | number | boolean> = {};
	const positionals: string[] = [];
	const unknown: string[] = [];

	for (let i = 0; i < args.length; i++) {
		let arg = args[i];

		// Resolve alias
		if (aliases[arg]) {
			arg = aliases[arg];
		}

		// Check if it's a flag (starts with -)
		if (arg.startsWith("-")) {
			const key = flagKey(arg);
			const longForm = arg.startsWith("--") ? arg : `--${key}`;

			// Passthrough: skip silently (consume value if it's a valued passthrough)
			if (passthroughFlags.has(key) || passthroughFlags.has(longForm)) {
				// If next arg exists and doesn't start with -, it's probably the value
				if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
					i++; // skip value
				}
				continue;
			}

			if (booleanFlags.has(key)) {
				flags[key] = true;
			} else if (stringFlags.has(key)) {
				if (i + 1 < args.length) {
					flags[key] = args[++i];
				} else {
					unknown.push(arg);
				}
			} else if (numberFlags.has(key)) {
				if (i + 1 < args.length) {
					const num = Number.parseInt(args[++i], 10);
					if (Number.isNaN(num)) {
						unknown.push(arg);
					} else {
						flags[key] = num;
					}
				} else {
					unknown.push(arg);
				}
			} else {
				// Unknown flag
				unknown.push(arg);
				// If next arg looks like a value (no dash prefix), skip it too
				// so we don't accidentally treat it as a positional
				if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
					i++;
				}
			}
		} else {
			positionals.push(arg);
		}
	}

	// Print warnings for unknown flags with suggestions
	if (unknown.length > 0) {
		const suggestions = unknown.map((flag) => {
			const suggestion = suggestFlag(flag, allKnownFlags);
			return suggestion ? `${flag} (did you mean ${suggestion}?)` : flag;
		});
		console.error(`Warning: unknown flag(s): ${suggestions.join(", ")}`);
	}

	return { flags, positionals, unknown };
}
