import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "./logger.js";

const logger = createLogger({ context: { component: "resolve-prompt" } });

// ---- Types ----

/**
 * Context passed to prompt resolution and code modules.
 */
export interface PromptContext {
	/** Directory containing randal.config.yaml */
	basePath: string;
	/** Template variables from identity.vars + auto-populated */
	vars?: Record<string, string>;
	/** Config name (auto-populated from config.name) */
	configName?: string;
}

// ---- Detection helpers ----

/**
 * Check if a value looks like a code module path (.ts or .js).
 * Layer 3 — checked first, since ./foo.ts matches both file-ref and module patterns.
 */
function isCodeModule(value: string): boolean {
	return value.endsWith(".ts") || value.endsWith(".js");
}

/**
 * Check if a value looks like a file reference.
 * Layer 1 — starts with ./ or /, or ends with .md or .txt.
 */
function isFileRef(value: string): boolean {
	return (
		value.startsWith("./") ||
		value.startsWith("/") ||
		value.endsWith(".md") ||
		value.endsWith(".txt")
	);
}

// ---- Template interpolation ----

/**
 * Replace {{key}} patterns with values from vars.
 * Unknown keys are left as-is with a debug warning.
 */
function interpolateTemplate(content: string, vars?: Record<string, string>): string {
	if (!vars) return content;

	return content.replace(/\{\{(\w[\w.]*)\}\}/g, (_match, key: string) => {
		if (key in vars) {
			return vars[key];
		}
		logger.debug("Template variable not found, leaving placeholder", { key });
		return `{{${key}}}`;
	});
}

// ---- Core resolver ----

/**
 * Resolve a raw config string into final prompt text.
 *
 * Resolution layers (checked in this order):
 *   1. Layer 3 — Code Module: .ts/.js → dynamic import → call default export
 *   2. Layer 1 — File Reference: ./path, /path, .md, .txt → readFileSync → template interpolation
 *   3. Layer 0 — Inline Passthrough: return as-is
 *
 * Template interpolation ({{var}}) only applies to file-loaded content (Layer 1).
 * Code modules (Layer 3) handle their own string construction.
 * Inline values (Layer 0) already have ${ENV_VAR} substitution at config parse time.
 */
export async function resolvePromptValue(value: string, ctx: PromptContext): Promise<string> {
	// Layer 3: Code module (.ts, .js)
	if (isCodeModule(value)) {
		const filePath = resolve(ctx.basePath, value);
		try {
			const mod = await import(filePath);
			const fn = mod.default;
			if (typeof fn !== "function") {
				throw new Error(`Code module does not export a default function: ${filePath}`);
			}
			const result = await fn(ctx);
			if (typeof result !== "string") {
				throw new Error(
					`Code module default export must return a string, got ${typeof result}: ${filePath}`,
				);
			}
			return result;
		} catch (err) {
			if (err instanceof Error && err.message.includes("Code module")) {
				throw err;
			}
			throw new Error(
				`Failed to load code module: ${filePath} — ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Layer 1: File reference (./path, /path, .md, .txt)
	if (isFileRef(value)) {
		const filePath = resolve(ctx.basePath, value);
		try {
			const content = readFileSync(filePath, "utf-8");
			// Apply template interpolation to file-loaded content
			return interpolateTemplate(content, ctx.vars);
		} catch (err) {
			throw new Error(
				`Failed to read prompt file: ${filePath} — ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Layer 0: Inline passthrough
	return value;
}

// ---- Array resolver ----

/**
 * Check if a string contains glob characters.
 */
function isGlobPattern(value: string): boolean {
	return value.includes("*") || value.includes("?") || value.includes("[");
}

/**
 * Resolve an array of prompt strings, handling mixed inline/file/module entries.
 *
 * For rules arrays:
 *   - Inline strings pass through as-is
 *   - File paths: load file, split by newlines, each non-empty line becomes a separate entry
 *   - Code modules: import, call default export. If result is string, split by newlines.
 *     If result is string[], use as-is.
 *
 * For knowledge arrays:
 *   - Glob patterns (contain *, ?, [) are returned as-is for existing loadKnowledgeFiles() handling
 *   - File/module paths are resolved and wrapped with --- header
 */
export async function resolvePromptArray(
	values: string[],
	ctx: PromptContext,
	options?: { mode?: "rules" | "knowledge" },
): Promise<string[]> {
	const results: string[] = [];
	const mode = options?.mode ?? "rules";

	for (const value of values) {
		if (mode === "knowledge" && isGlobPattern(value)) {
			// Glob patterns pass through for existing loadKnowledgeFiles() handling
			results.push(value);
			continue;
		}

		// Code module
		if (isCodeModule(value)) {
			const filePath = resolve(ctx.basePath, value);
			try {
				const mod = await import(filePath);
				const fn = mod.default;
				if (typeof fn !== "function") {
					throw new Error(`Code module does not export a default function: ${filePath}`);
				}
				const result = await fn(ctx);

				if (mode === "rules") {
					if (Array.isArray(result)) {
						results.push(...result.filter((s: string) => typeof s === "string" && s.trim()));
					} else if (typeof result === "string") {
						results.push(...result.split("\n").filter((line: string) => line.trim()));
					} else {
						throw new Error(
							`Rules module must return string or string[], got ${typeof result}: ${filePath}`,
						);
					}
				} else {
					// knowledge mode: wrap with header
					const content = typeof result === "string" ? result : (result as string[]).join("\n");
					results.push(`--- ${value} ---\n${content}`);
				}
			} catch (err) {
				if (
					err instanceof Error &&
					(err.message.includes("Code module") || err.message.includes("Rules module"))
				) {
					throw err;
				}
				throw new Error(
					`Failed to load code module: ${filePath} — ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			continue;
		}

		// File reference
		if (isFileRef(value)) {
			const filePath = resolve(ctx.basePath, value);
			try {
				const content = readFileSync(filePath, "utf-8");
				const interpolated = interpolateTemplate(content, ctx.vars);

				if (mode === "rules") {
					// Split file content into individual rules (one per non-empty line)
					results.push(...interpolated.split("\n").filter((line) => line.trim()));
				} else {
					// knowledge mode: wrap with header
					results.push(`--- ${value} ---\n${interpolated}`);
				}
			} catch (err) {
				throw new Error(
					`Failed to read prompt file: ${filePath} — ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			continue;
		}

		// Inline passthrough
		results.push(value);
	}

	return results;
}
