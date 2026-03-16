import { z } from "zod";
import { substituteEnvVars } from "./config.js";

/**
 * Posse manifest schema (posse.config.yaml).
 * Defines the structure for multi-agent posse coordination.
 */
export const posseConfigSchema = z.object({
	name: z.string().min(1, "Posse name is required"),
	version: z.string().default("0.1"),

	infrastructure: z
		.object({
			meilisearch: z
				.object({
					mode: z.enum(["embedded", "shared"]).default("embedded"),
					url: z.string().optional(),
					apiKey: z.string().optional(),
				})
				.default({}),
		})
		.default({}),

	agents: z
		.array(
			z.object({
				name: z.string().min(1, "Agent name is required"),
				config: z.string().min(1, "Agent config path is required"),
			}),
		)
		.min(1, "At least one agent is required"),

	memory: z
		.object({
			topology: z.enum(["full-mesh", "hub-spoke", "manual"]).default("full-mesh"),
			sharedIndex: z.string().optional(),
		})
		.default({}),
});

export type PosseConfig = z.infer<typeof posseConfigSchema>;

/**
 * Parse and validate a posse config from a YAML string.
 * Supports ${VAR} environment variable substitution.
 */
export function parsePosseConfig(yamlContent: string): PosseConfig {
	const { parse: parseYaml } = require("yaml");
	const parsed = parseYaml(yamlContent);
	const substituted = substituteEnvVars(parsed);
	return posseConfigSchema.parse(substituted);
}
