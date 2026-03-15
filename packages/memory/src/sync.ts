import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RandalConfig } from "@randal/core";
import { createLogger } from "@randal/core";
import { watch } from "chokidar";
import { parseLearnings } from "./learnings.js";
import type { MemoryManager } from "./memory.js";

export interface SyncOptions {
	config: RandalConfig;
	basePath: string;
	memoryManager: MemoryManager;
}

const logger = createLogger({ context: { component: "memory-sync" } });

/**
 * Compute SHA-256 hash of content.
 */
export function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Start file watcher for memory files.
 * Syncs changes to the memory store.
 */
export function startSync(options: SyncOptions): { stop: () => void } {
	const { config, basePath, memoryManager } = options;
	const hashes = new Map<string, string>();

	// Watch configured memory files
	const watchPaths = config.memory.files.map((f) => join(basePath, f));

	// Pre-populate hashes from existing files to prevent re-indexing on restart
	for (const file of watchPaths) {
		if (existsSync(file)) {
			try {
				const content = readFileSync(file, "utf-8");
				const hash = hashContent(content);
				hashes.set(file, hash);
			} catch {
				// Ignore read errors on startup
			}
		}
	}

	const watcher = watch(watchPaths, {
		persistent: true,
		ignoreInitial: false,
	});

	async function handleChange(filePath: string): Promise<void> {
		if (!existsSync(filePath)) return;

		try {
			const content = readFileSync(filePath, "utf-8");
			const hash = hashContent(content);

			// Skip if content hasn't changed
			if (hashes.get(filePath) === hash) return;
			hashes.set(filePath, hash);

			logger.info("Memory file changed", { file: filePath });

			// Index full snapshot
			await memoryManager.index({
				type: "snapshot",
				file: filePath,
				content,
				contentHash: hash,
				category: "fact",
				source: "self",
				timestamp: new Date().toISOString(),
			});

			// Parse and index individual learnings
			const learnings = parseLearnings(content);
			for (const learning of learnings) {
				await memoryManager.index({
					type: "learning",
					file: filePath,
					content: learning.content,
					contentHash: hashContent(learning.content),
					category: learning.category,
					source: "self",
					timestamp: new Date().toISOString(),
				});
			}
		} catch (err) {
			logger.error("Failed to sync memory file", {
				file: filePath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	watcher.on("change", handleChange);
	watcher.on("add", handleChange);

	return {
		stop: () => {
			watcher.close();
		},
	};
}
