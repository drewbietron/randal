import type { PosseConfig } from "./posse-config.js";

export interface ResolvedAgentConfig {
	/** Agent name */
	name: string;
	/** Path to agent's config file */
	configPath: string;
	/** Memory sharing overrides to inject */
	memorySharing: {
		publishTo?: string;
		readFrom: string[];
	};
	/** Skills sharing overrides to inject */
	skillsSharing: {
		publishTo?: string;
		readFrom: string[];
	};
	/** Infrastructure overrides (when mode=shared) */
	infrastructure?: {
		memoryUrl: string;
		memoryApiKey: string;
		skipMeilisearch: boolean;
	};
}

/**
 * Resolve a posse manifest into per-agent configuration overrides.
 *
 * @param manifest - Parsed posse.config.yaml
 * @returns Array of resolved agent configurations with sharing injections
 */
export function resolvePosseConfig(manifest: PosseConfig): ResolvedAgentConfig[] {
	// Validate unique agent names (R4.5)
	const names = manifest.agents.map((a) => a.name);
	const uniqueNames = new Set(names);
	if (uniqueNames.size !== names.length) {
		const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
		throw new Error(
			`Duplicate agent names in posse manifest: ${[...new Set(duplicates)].join(", ")}`,
		);
	}

	const sharedIndex = manifest.memory.sharedIndex ?? `shared-${manifest.name}`;
	const sharedSkillsIndex = `shared-skills-${manifest.name}`;

	const topology = manifest.memory.topology;
	const results: ResolvedAgentConfig[] = [];

	for (const agent of manifest.agents) {
		let memorySharing: ResolvedAgentConfig["memorySharing"];
		let skillsSharing: ResolvedAgentConfig["skillsSharing"];

		switch (topology) {
			case "full-mesh": {
				// Every agent publishes to shared and reads from shared + all other agents' private indexes
				const otherIndexes = manifest.agents
					.filter((a) => a.name !== agent.name)
					.map((a) => `memory-${a.name}`);
				memorySharing = {
					publishTo: sharedIndex,
					readFrom: [sharedIndex, ...otherIndexes],
				};

				const otherSkillIndexes = manifest.agents
					.filter((a) => a.name !== agent.name)
					.map((a) => `skills-${a.name}`);
				skillsSharing = {
					publishTo: sharedSkillsIndex,
					readFrom: [sharedSkillsIndex, ...otherSkillIndexes],
				};
				break;
			}
			case "hub-spoke": {
				// Every agent publishes to shared and reads only from shared (not other agents' private indexes)
				memorySharing = {
					publishTo: sharedIndex,
					readFrom: [sharedIndex],
				};
				skillsSharing = {
					publishTo: sharedSkillsIndex,
					readFrom: [sharedSkillsIndex],
				};
				break;
			}
			case "manual": {
				// No injection — the user configures sharing per-agent manually
				memorySharing = { readFrom: [] };
				skillsSharing = { readFrom: [] };
				break;
			}
		}

		const resolved: ResolvedAgentConfig = {
			name: agent.name,
			configPath: agent.config,
			memorySharing,
			skillsSharing,
		};

		// Infrastructure overrides for shared mode (R4.3)
		if (manifest.infrastructure.meilisearch.mode === "shared") {
			const url = manifest.infrastructure.meilisearch.url;
			const apiKey = manifest.infrastructure.meilisearch.apiKey;

			if (!url || !apiKey) {
				throw new Error(
					"Shared Meilisearch mode requires url and apiKey in infrastructure.meilisearch",
				);
			}

			resolved.infrastructure = {
				memoryUrl: url,
				memoryApiKey: apiKey,
				skipMeilisearch: true,
			};
		}

		results.push(resolved);
	}

	return results;
}
