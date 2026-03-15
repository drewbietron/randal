import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RandalConfig } from "@randal/core";
import { filterAllowed, getInherited, parseEnvFile } from "./credentials.js";
import { type SandboxResult, applySandbox } from "./sandbox.js";
import { type ResolvedServices, mountServiceFiles, resolveServices } from "./service-resolver.js";

/**
 * Build a clean process environment for a child agent process.
 *
 * Pipeline:
 *   1. Load .env + allowlist filter (existing)
 *   2. Add inherited vars from parent process (existing)
 *   3. Resolve services (new, Phase 2)
 *   4. Apply sandbox restrictions (new, Phase 3)
 *
 * Nothing else leaks through.
 */
export async function buildProcessEnv(
	config: RandalConfig,
	basePath?: string,
): Promise<{
	env: Record<string, string>;
	tempHome: string | null;
	auditLog: ResolvedServices["auditLog"];
}> {
	const env: Record<string, string> = {};
	const resolvedBasePath = basePath ?? ".";

	// 1. Load and filter env file vars
	const envFilePath = resolve(resolvedBasePath, config.credentials.envFile);
	try {
		const content = readFileSync(envFilePath, "utf-8");
		const fileVars = parseEnvFile(content);
		const allowed = filterAllowed(fileVars, config.credentials.allow);
		Object.assign(env, allowed);
	} catch {
		// Env file doesn't exist — that's fine, just use inherited
	}

	// 2. Add inherited vars from parent process
	const inherited = getInherited(config.credentials.inherit);
	Object.assign(env, inherited);

	// 3. Resolve services
	const serviceResult = await resolveServices(config.services, resolvedBasePath);
	Object.assign(env, serviceResult.vars);

	// Mount service files (if any)
	if (serviceResult.fileMounts.length > 0) {
		mountServiceFiles(serviceResult.fileMounts);
	}

	// 4. Apply sandbox restrictions
	const sandboxResult: SandboxResult = applySandbox(config.sandbox, env, serviceResult);

	return {
		env: sandboxResult.env,
		tempHome: sandboxResult.tempHome,
		auditLog: serviceResult.auditLog,
	};
}

/**
 * Build process env synchronously (legacy compatibility).
 * Does NOT resolve services or apply sandbox -- use the async version for full pipeline.
 */
export function buildProcessEnvSync(
	config: RandalConfig,
	basePath?: string,
): Record<string, string> {
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
