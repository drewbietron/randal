import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RandalConfig, SkillDeployment, SkillDoc } from "@randal/core";
import { createLogger } from "@randal/core";
import { MeiliSearch } from "meilisearch";
import type { MemoryManager } from "../memory.js";
import { parseSkillFile } from "./parser.js";

const logger = createLogger({ context: { component: "skill-manager" } });

export interface SkillManagerOptions {
	config: RandalConfig;
	basePath: string;
	memoryManager?: MemoryManager;
}

export class SkillManager {
	private config: RandalConfig;
	private basePath: string;
	private memoryManager?: MemoryManager;
	private client: MeiliSearch;
	private indexName: string;
	private skills: Map<string, SkillDoc> = new Map();

	constructor(options: SkillManagerOptions) {
		this.config = options.config;
		this.basePath = options.basePath;
		this.memoryManager = options.memoryManager;

		this.client = new MeiliSearch({
			host: options.config.memory.url,
			apiKey: options.config.memory.apiKey,
		});

		this.indexName = options.config.skills.index ?? `skills-${options.config.name}`;
	}

	/**
	 * Initialize the skill manager: configure Meilisearch index and scan directory.
	 */
	async init(): Promise<void> {
		try {
			const index = this.client.index(this.indexName);

			await index.updateSearchableAttributes([
				"content",
				"meta.name",
				"meta.description",
				"meta.tags",
			]);
			await index.updateFilterableAttributes(["meta.tags", "meta.name", "meta.version"]);
			await index.updateSortableAttributes(["updated"]);

			logger.info("Skills index initialized", { index: this.indexName });
		} catch (err) {
			logger.warn("Skills Meilisearch init failed, skill search disabled", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		await this.scanDirectory();
	}

	/**
	 * Search for skills relevant to a query.
	 */
	async search(query: string, limit?: number): Promise<SkillDoc[]> {
		const max = limit ?? this.config.skills.maxPerPrompt;

		try {
			const index = this.client.index(this.indexName);
			const results = await index.search(query, {
				limit: max,
				sort: ["updated:desc"],
			});
			return results.hits as unknown as SkillDoc[];
		} catch {
			// Fallback to in-memory search
			return this.searchInMemory(query, max);
		}
	}

	/**
	 * Search and prepare skills for deployment, including memory-correlated outcomes.
	 */
	async searchWithOutcomes(query: string): Promise<SkillDeployment[]> {
		const skills = await this.search(query, this.config.skills.maxPerPrompt);
		const deployments: SkillDeployment[] = [];

		for (const skill of skills) {
			let enrichedContent = skill.content;

			if (this.memoryManager) {
				try {
					const outcomes = await this.memoryManager.search(`skill-outcome ${skill.meta.name}`, 3);
					if (outcomes.length > 0) {
						enrichedContent += "\n\n## Learned from experience\n";
						enrichedContent += outcomes.map((o) => `- ${o.content}`).join("\n");
					}
				} catch {
					// Memory search failed, continue without outcomes
				}
			}

			deployments.push({
				name: skill.meta.name,
				description: skill.meta.description,
				content: enrichedContent,
				frontmatter: { ...skill.meta },
			});
		}

		return deployments;
	}

	/**
	 * Search for skills and return formatted strings for prompt injection.
	 */
	async searchForPrompt(query: string): Promise<string[]> {
		const deployments = await this.searchWithOutcomes(query);
		return deployments.map((s) => `--- Skill: ${s.name} ---\n${s.content}`);
	}

	/**
	 * Get a skill by name.
	 */
	async getByName(name: string): Promise<SkillDoc | null> {
		return this.skills.get(name) ?? null;
	}

	/**
	 * List all known skills.
	 */
	async list(): Promise<SkillDoc[]> {
		return [...this.skills.values()];
	}

	/**
	 * Scan the skills directory and index all found skills.
	 */
	async scanDirectory(): Promise<void> {
		const skillsDir = resolve(this.basePath, this.config.skills.dir);

		if (!existsSync(skillsDir)) {
			logger.info("Skills directory does not exist, skipping scan", { dir: skillsDir });
			return;
		}

		const entries = readdirSync(skillsDir, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const skillFile = join(skillsDir, entry.name, "SKILL.md");
			if (!existsSync(skillFile)) continue;

			try {
				const skill = parseSkillFile(skillFile);
				this.skills.set(skill.meta.name, skill);
				await this.indexSkill(skill);
			} catch (err) {
				logger.warn("Failed to parse skill", {
					file: skillFile,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		logger.info("Skills scanned", { count: this.skills.size, dir: skillsDir });
	}

	/**
	 * Start a file watcher for the skills directory.
	 * Returns a stop function.
	 */
	startWatcher(): { stop: () => void } {
		// Dynamic import to avoid issues in non-watch scenarios
		const chokidar = require("chokidar");
		const skillsDir = resolve(this.basePath, this.config.skills.dir);

		const watcher = chokidar.watch(join(skillsDir, "*/SKILL.md"), {
			persistent: true,
			ignoreInitial: true,
		});

		watcher.on("add", async (filePath: string) => {
			try {
				const skill = parseSkillFile(filePath);
				this.skills.set(skill.meta.name, skill);
				await this.indexSkill(skill);
				logger.info("Skill added", { name: skill.meta.name });
			} catch (err) {
				logger.warn("Failed to process new skill", {
					file: filePath,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

		watcher.on("change", async (filePath: string) => {
			try {
				const skill = parseSkillFile(filePath);
				this.skills.set(skill.meta.name, skill);
				await this.indexSkill(skill);
				logger.info("Skill updated", { name: skill.meta.name });
			} catch (err) {
				logger.warn("Failed to process updated skill", {
					file: filePath,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

		watcher.on("unlink", (filePath: string) => {
			// Find and remove the skill by filepath
			for (const [name, skill] of this.skills) {
				if (skill.filePath === filePath) {
					this.skills.delete(name);
					logger.info("Skill removed", { name });
					break;
				}
			}
		});

		return {
			stop: () => {
				watcher.close();
			},
		};
	}

	private async indexSkill(skill: SkillDoc): Promise<void> {
		try {
			const index = this.client.index(this.indexName);
			await index.addDocuments([
				{
					id: skill.meta.name,
					...skill,
				},
			]);
		} catch {
			// Silently fail — skill is still in memory
		}
	}

	private searchInMemory(query: string, limit: number): SkillDoc[] {
		const lower = query.toLowerCase();
		const scored: Array<{ skill: SkillDoc; score: number }> = [];

		for (const skill of this.skills.values()) {
			let score = 0;
			const name = skill.meta.name.toLowerCase();
			const desc = skill.meta.description.toLowerCase();
			const content = skill.content.toLowerCase();
			const tags = (skill.meta.tags ?? []).map((t) => t.toLowerCase());

			if (name.includes(lower)) score += 10;
			if (desc.includes(lower)) score += 5;
			if (content.includes(lower)) score += 1;
			for (const tag of tags) {
				if (tag.includes(lower)) score += 3;
			}

			if (score > 0) {
				scored.push({ skill, score });
			}
		}

		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((s) => s.skill);
	}
}
