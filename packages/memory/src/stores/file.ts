import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryDoc } from "@randal/core";
import type { MemoryStore } from "./index.js";

export interface FileStoreOptions {
	basePath: string;
	files: string[];
}

/**
 * Simple file-based memory store. Reads/writes MEMORY.md files.
 * Provides basic search via string matching.
 */
export class FileStore implements MemoryStore {
	private basePath: string;
	private files: string[];
	private docs: MemoryDoc[] = [];

	constructor(options: FileStoreOptions) {
		this.basePath = options.basePath;
		this.files = options.files;
	}

	async init(): Promise<void> {
		this.docs = [];
		for (const file of this.files) {
			const path = join(this.basePath, file);
			if (existsSync(path)) {
				const content = readFileSync(path, "utf-8");
				this.docs.push({
					id: randomUUID(),
					type: "snapshot",
					file,
					content,
					contentHash: createHash("sha256").update(content).digest("hex"),
					category: "fact",
					source: "self",
					timestamp: new Date().toISOString(),
				});
			}
		}
	}

	async search(query: string, limit: number): Promise<MemoryDoc[]> {
		const lower = query.toLowerCase();
		return this.docs.filter((d) => d.content.toLowerCase().includes(lower)).slice(0, limit);
	}

	async index(doc: Omit<MemoryDoc, "id">): Promise<void> {
		// Deduplication: skip if a doc with the same contentHash already exists
		if (doc.contentHash && this.docs.some((d) => d.contentHash === doc.contentHash)) {
			return;
		}

		const fullDoc: MemoryDoc = {
			...doc,
			id: randomUUID(),
		};
		this.docs.push(fullDoc);

		// Append to file using atomic write (write to temp, then rename)
		const path = join(this.basePath, doc.file || "MEMORY.md");
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const line = `- [${doc.category}] ${doc.content}\n`;
		const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, existing + line, "utf-8");
		renameSync(tmp, path);
	}

	async recent(limit: number): Promise<MemoryDoc[]> {
		return this.docs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
	}
}
