/**
 * Docker management utilities for the MCP memory server.
 *
 * Handles auto-starting the Meilisearch Docker container and scheduling
 * periodic database dumps.
 */

import { execSync } from "node:child_process";
import { log } from "../lib/mcp-transport.js";
import { MEILI_DUMP_INTERVAL_MS, MEILI_MASTER_KEY, MEILI_URL } from "./types.js";

// ---------------------------------------------------------------------------
// Periodic dump scheduling
// ---------------------------------------------------------------------------

/**
 * Schedule periodic Meilisearch dumps via POST /dumps API.
 * Works for both local and remote Meilisearch instances.
 */
export function startDumpScheduler(): void {
	if (MEILI_DUMP_INTERVAL_MS <= 0) {
		log("info", "Dump scheduling disabled (MEILI_DUMP_INTERVAL_MS <= 0)");
		return;
	}
	log(
		"info",
		`Dump scheduler started: interval ${MEILI_DUMP_INTERVAL_MS}ms (${(MEILI_DUMP_INTERVAL_MS / 3600000).toFixed(1)}h)`,
	);

	setInterval(async () => {
		try {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (MEILI_MASTER_KEY) {
				headers.Authorization = `Bearer ${MEILI_MASTER_KEY}`;
			}
			const resp = await fetch(`${MEILI_URL}/dumps`, {
				method: "POST",
				headers,
			});
			if (resp.ok) {
				const body = await resp.json();
				log("info", `Dump triggered successfully: ${JSON.stringify(body)}`);
			} else {
				log("warn", `Dump request failed: ${resp.status} ${resp.statusText}`);
			}
		} catch (err) {
			log("warn", `Dump request error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, MEILI_DUMP_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Meilisearch auto-start (Docker container)
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-start the Meilisearch Docker container if it isn't running.
 * Called before retryInit() to handle the common case of a stopped container.
 * Never throws — logs warnings and returns on any failure.
 */
export async function tryStartMeilisearch(): Promise<void> {
	// 1. Check RANDAL_SKIP_MEILISEARCH env var
	if (process.env.RANDAL_SKIP_MEILISEARCH === "true") {
		log("info", "Meilisearch auto-start skipped (RANDAL_SKIP_MEILISEARCH=true)");
		return;
	}

	// 2. Health check — if already healthy, return immediately
	try {
		const resp = await fetch(`${MEILI_URL}/health`, { signal: AbortSignal.timeout(3000) });
		if (resp.ok) {
			log("info", "Meilisearch already healthy — skipping auto-start");
			return;
		}
	} catch {
		// Not reachable — continue to auto-start attempt
	}

	// 3. Attempt docker start
	log("info", "Meilisearch not reachable — attempting docker start randal-meili");
	try {
		execSync("docker start randal-meili", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
		});
		log("info", "docker start randal-meili succeeded — waiting for healthy");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("No such container")) {
			log(
				"warn",
				"Container randal-meili does not exist — skipping auto-start. Run scripts/meili-start.sh to create it.",
			);
		} else if (
			msg.includes("ENOENT") ||
			msg.includes("not found") ||
			msg.includes("command not found")
		) {
			log("warn", "Docker not available — skipping Meilisearch auto-start");
		} else {
			log("warn", `docker start failed: ${msg} — skipping auto-start`);
		}
		return;
	}

	// 4. Poll health endpoint up to 10 times (1s apart)
	for (let i = 1; i <= 10; i++) {
		await Bun.sleep(1000);
		try {
			const resp = await fetch(`${MEILI_URL}/health`, { signal: AbortSignal.timeout(2000) });
			if (resp.ok) {
				log("info", `Meilisearch healthy after ${i}s`);
				return;
			}
		} catch {
			// Not yet ready — continue polling
		}
		if (i < 10) {
			log("info", `Waiting for Meilisearch... (${i}/10)`);
		}
	}

	log(
		"warn",
		"Meilisearch did not become healthy within 10s after docker start — retryInit will handle backoff",
	);
}
