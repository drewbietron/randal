import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RandalConfig } from "@randal/core";
import { filterAllowed, getInherited, parseEnvFile } from "./credentials.js";

/**
 * Build a clean process environment for a child agent process.
 * Only includes:
 *   1. Variables from the env file that are in the allow list
 *   2. Variables inherited from the parent process
 *
 * Nothing else leaks through.
 */
export function buildProcessEnv(config: RandalConfig, basePath?: string): Record<string, string> {
	const env: Record<string, string> = {};

	// Load and filter env file vars
	const envFilePath = resolve(basePath ?? ".", config.credentials.envFile);
	try {
		const content = readFileSync(envFilePath, "utf-8");
		const fileVars = parseEnvFile(content);
		const allowed = filterAllowed(fileVars, config.credentials.allow);
		Object.assign(env, allowed);
	} catch {
		// Env file doesn't exist — that's fine, just use inherited
	}

	// Add inherited vars from parent process
	const inherited = getInherited(config.credentials.inherit);
	Object.assign(env, inherited);

	return env;
}

/**
 * Audit which credentials are loaded, missing, and inherited.
 */
export function auditCredentials(
	config: RandalConfig,
	basePath?: string,
): { loaded: string[]; missing: string[]; inherited: string[] } {
	const loaded: string[] = [];
	const missing: string[] = [];
	const inherited: string[] = [];

	// Check env file vars
	const envFilePath = resolve(basePath ?? ".", config.credentials.envFile);
	try {
		const content = readFileSync(envFilePath, "utf-8");
		const fileVars = parseEnvFile(content);
		for (const key of config.credentials.allow) {
			if (key in fileVars) {
				loaded.push(key);
			} else {
				missing.push(key);
			}
		}
	} catch {
		// File doesn't exist — all allowed vars are missing
		missing.push(...config.credentials.allow);
	}

	// Check inherited
	for (const key of config.credentials.inherit) {
		if (process.env[key] !== undefined) {
			inherited.push(key);
		}
	}

	return { loaded, missing, inherited };
}
