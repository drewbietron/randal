/**
 * Posse discovery via Meilisearch index naming conventions.
 *
 * Naming conventions:
 *   - memory-<agent-name>  — agent private memory indexes
 *   - shared-<posse-name>  — shared posse memory indexes
 *   - skills-<agent-name>  — agent private skill indexes
 *   - shared-skills-<posse-name> — shared posse skill indexes
 *   - posse-registry-<posse-name> — posse registry indexes
 */

export interface IndexInfo {
	uid: string;
	type:
		| "agent-memory"
		| "shared-memory"
		| "agent-skills"
		| "shared-skills"
		| "posse-registry"
		| "unknown";
	agentName?: string;
	posseName?: string;
}

/**
 * Parse an index name into its type and metadata.
 */
export function parseIndexName(indexUid: string): IndexInfo {
	// posse-registry-<posse-name>
	if (indexUid.startsWith("posse-registry-")) {
		return {
			uid: indexUid,
			type: "posse-registry",
			posseName: indexUid.slice("posse-registry-".length),
		};
	}

	// shared-skills-<posse-name>
	if (indexUid.startsWith("shared-skills-")) {
		return {
			uid: indexUid,
			type: "shared-skills",
			posseName: indexUid.slice("shared-skills-".length),
		};
	}

	// shared-<posse-name>
	if (indexUid.startsWith("shared-")) {
		return {
			uid: indexUid,
			type: "shared-memory",
			posseName: indexUid.slice("shared-".length),
		};
	}

	// skills-<agent-name>
	if (indexUid.startsWith("skills-")) {
		return {
			uid: indexUid,
			type: "agent-skills",
			agentName: indexUid.slice("skills-".length),
		};
	}

	// memory-<agent-name>
	if (indexUid.startsWith("memory-")) {
		return {
			uid: indexUid,
			type: "agent-memory",
			agentName: indexUid.slice("memory-".length),
		};
	}

	return { uid: indexUid, type: "unknown" };
}

/**
 * Extract agent name from a memory index name.
 * Returns undefined if the index name doesn't match the memory-<name> pattern.
 */
export function parseAgentNameFromIndex(indexName: string): string | undefined {
	if (indexName.startsWith("memory-")) {
		return indexName.slice("memory-".length);
	}
	return undefined;
}

/**
 * Filter a list of index UIDs by naming convention.
 */
export function filterPosseIndexes(
	indexUids: string[],
	posseName?: string,
): {
	agentMemoryIndexes: IndexInfo[];
	sharedMemoryIndexes: IndexInfo[];
	registryIndexes: IndexInfo[];
	skillIndexes: IndexInfo[];
} {
	const parsed = indexUids.map(parseIndexName);

	return {
		agentMemoryIndexes: parsed.filter((i) => i.type === "agent-memory"),
		sharedMemoryIndexes: parsed.filter(
			(i) => i.type === "shared-memory" && (!posseName || i.posseName === posseName),
		),
		registryIndexes: parsed.filter(
			(i) => i.type === "posse-registry" && (!posseName || i.posseName === posseName),
		),
		skillIndexes: parsed.filter((i) => i.type === "agent-skills" || i.type === "shared-skills"),
	};
}

/**
 * Discover posse members from a list of index UIDs.
 * Returns agent names found by parsing memory-<name> index naming.
 */
export function discoverPosseMembers(indexUids: string[]): string[] {
	return indexUids
		.map(parseAgentNameFromIndex)
		.filter((name): name is string => name !== undefined);
}
