/**
 * Parse a .env file into a key-value map.
 * Handles:
 *   - KEY=value
 *   - KEY="quoted value"
 *   - KEY='single quoted'
 *   - Comments (lines starting with #)
 *   - Empty lines
 */
export function parseEnvFile(content: string): Record<string, string> {
	const vars: Record<string, string> = {};

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;

		const key = trimmed.slice(0, eqIdx).trim();
		let value = trimmed.slice(eqIdx + 1).trim();

		// Remove surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key) {
			vars[key] = value;
		}
	}

	return vars;
}

/**
 * Filter environment variables based on allow list.
 * Only keys in the allow list are returned.
 */
export function filterAllowed(
	vars: Record<string, string>,
	allow: string[],
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of allow) {
		if (key in vars) {
			result[key] = vars[key];
		}
	}
	return result;
}

/**
 * Get inherited variables from the current process environment.
 */
export function getInherited(keys: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of keys) {
		const value = process.env[key];
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}
