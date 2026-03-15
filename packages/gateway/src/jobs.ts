import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Job, JobStatus } from "@randal/core";
import { createLogger } from "@randal/core";
import { parse, stringify } from "yaml";

const logger = createLogger({ context: { component: "jobs" } });

let JOBS_DIR = join(homedir(), ".randal", "jobs");

/**
 * Set the jobs directory (for testing).
 */
export function setJobsDir(dir: string): void {
	JOBS_DIR = dir;
}

/**
 * Get the current jobs directory.
 */
export function getJobsDir(): string {
	return JOBS_DIR;
}

function ensureDir(): void {
	if (!existsSync(JOBS_DIR)) {
		mkdirSync(JOBS_DIR, { recursive: true });
	}
}

/**
 * Sanitize a job ID for use in file paths, preventing directory traversal.
 */
function sanitizeJobId(id: string): string {
	// Strip any path separators and parent directory references
	const sanitized = id.replace(/[/\\]/g, "").replace(/\.\./g, "");
	if (!sanitized || sanitized !== id) {
		throw new Error(`Invalid job ID: ${id}`);
	}
	return sanitized;
}

function jobPath(id: string): string {
	return join(JOBS_DIR, `${sanitizeJobId(id)}.yaml`);
}

/**
 * Save a job to disk as YAML. Uses atomic write (temp + rename) to prevent corruption.
 */
export function saveJob(job: Job): void {
	ensureDir();
	const target = jobPath(job.id);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, stringify(job), "utf-8");
	renameSync(tmp, target);
}

/**
 * Load a job from disk.
 */
export function loadJob(id: string): Job | null {
	const path = jobPath(id);
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, "utf-8");
		return parse(content) as Job;
	} catch {
		return null;
	}
}

/**
 * List all jobs, optionally filtered by status.
 */
export function listJobs(status?: JobStatus): Job[] {
	ensureDir();
	const files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".yaml"));
	const jobs: Job[] = [];

	for (const file of files) {
		try {
			const content = readFileSync(join(JOBS_DIR, file), "utf-8");
			const job = parse(content) as Job;
			if (!status || job.status === status) {
				jobs.push(job);
			}
		} catch {
			// Skip corrupt files
		}
	}

	return jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Update a job on disk. Loads, applies updates, saves.
 * Prevents overwriting immutable fields (id, createdAt).
 */
export function updateJob(id: string, updates: Partial<Omit<Job, "id" | "createdAt">>): Job | null {
	const job = loadJob(id);
	if (!job) return null;

	Object.assign(job, updates);
	saveJob(job);
	return job;
}
