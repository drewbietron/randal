import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RandalConfig } from "@randal/core";

// ---- Types ----

type ServiceMap = RandalConfig["services"];
type ServiceConfig = ServiceMap[string];

export interface ResolvedServices {
	/** Env vars to inject into the child process */
	vars: Record<string, string>;
	/** Binaries that must remain in PATH (from ambient services) */
	allowBinaries: string[];
	/** Binaries to strip from PATH (from type: none services) */
	blockBinaries: string[];
	/** Env var names to remove from the child env */
	scrubVars: string[];
	/** Files to copy into position before spawning */
	fileMounts: { src: string; dest: string }[];
	/** Audit log entries for services that have audit: true */
	auditLog: { service: string; type: string }[];
}

// ---- Script execution cache ----

interface CachedResult {
	value: string;
	expiresAt: number;
}

const scriptCache = new Map<string, CachedResult>();

async function runScript(command: string, basePath: string): Promise<string> {
	const resolved = resolve(basePath, command);
	const proc = Bun.spawn(["bash", "-c", resolved], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: basePath,
	});

	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		throw new Error(`Service script '${command}' exited with code ${exitCode}`);
	}

	return stdout.trim();
}

async function getScriptValue(
	command: string,
	ttl: number | undefined,
	basePath: string,
): Promise<string> {
	const cacheKey = `${basePath}:${command}`;
	const cached = scriptCache.get(cacheKey);

	if (cached && Date.now() < cached.expiresAt) {
		return cached.value;
	}

	const value = await runScript(command, basePath);

	if (ttl && ttl > 0) {
		scriptCache.set(cacheKey, {
			value,
			expiresAt: Date.now() + ttl * 1000,
		});
	}

	return value;
}

// ---- Resolver ----

/**
 * Resolve all configured services into a flat set of env vars,
 * binary allow/block lists, file mounts, and audit entries.
 */
export async function resolveServices(
	services: Record<string, ServiceConfig> | undefined,
	basePath: string,
): Promise<ResolvedServices> {
	const result: ResolvedServices = {
		vars: {},
		allowBinaries: [],
		blockBinaries: [],
		scrubVars: [],
		fileMounts: [],
		auditLog: [],
	};

	if (!services) return result;

	for (const [name, service] of Object.entries(services)) {
		const cred = service.credentials;

		if (service.audit) {
			result.auditLog.push({ service: name, type: cred.type });
		}

		switch (cred.type) {
			case "env": {
				// Inject env vars directly
				for (const [key, value] of Object.entries(cred.vars)) {
					result.vars[key] = value;
				}
				break;
			}

			case "file": {
				// Copy file and set env vars
				const srcPath = resolve(basePath, cred.file);
				if (existsSync(srcPath)) {
					result.fileMounts.push({ src: srcPath, dest: cred.mountAs });

					for (const [key, value] of Object.entries(cred.vars)) {
						result.vars[key] = value;
					}
				}
				break;
			}

			case "ambient": {
				// Record which binaries and paths to keep available
				result.allowBinaries.push(...cred.binaries);
				break;
			}

			case "script": {
				// Execute script and capture stdout as variable value
				try {
					const output = await getScriptValue(cred.command, cred.ttl, basePath);

					for (const [key, source] of Object.entries(cred.vars)) {
						if (source === "stdout") {
							result.vars[key] = output;
						} else {
							result.vars[key] = source;
						}
					}
				} catch {
					// Script failed -- skip this service's vars
				}
				break;
			}

			case "none": {
				// Block binaries and scrub env vars
				result.blockBinaries.push(...cred.binaries);
				result.scrubVars.push(...cred.vars);
				break;
			}
		}
	}

	return result;
}

/**
 * Mount files required by services.
 * Copies source files to their mount destinations.
 */
export function mountServiceFiles(mounts: ResolvedServices["fileMounts"]): void {
	const { copyFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
	const { dirname } = require("node:path") as typeof import("node:path");

	for (const mount of mounts) {
		if (existsSync(mount.src)) {
			mkdirSync(dirname(mount.dest), { recursive: true });
			copyFileSync(mount.src, mount.dest);
		}
	}
}
