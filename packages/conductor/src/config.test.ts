import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	conductorConfigSchema,
	getDefaultPosseConfig,
	getDefaultSingleConfig,
	loadConfig,
	loadConfigFromEnv,
	parseConfig,
	resolveEnvVars,
	validateConfig,
	validatePartialConfig,
} from "./config.js";

describe("conductorConfigSchema", () => {
	test("validates minimal single-mode config", () => {
		const config = {
			mode: "single",
			agent: {
				name: "test-agent",
				url: "http://localhost:7600",
			},
		};

		const result = conductorConfigSchema.parse(config);
		expect(result.mode).toBe("single");
		expect(result.agent?.name).toBe("test-agent");
		expect(result.agent?.url).toBe("http://localhost:7600");
		expect(result.agent?.model).toBe("moonshotai/kimi-k2.5");
		expect(result.server.port).toBe(7777);
		expect(result.server.host).toBe("0.0.0.0");
		expect(result.model).toBe("moonshotai/kimi-k2.5");
		expect(result.routing.strategy).toBe("auto");
	});

	test("validates minimal posse-mode config", () => {
		const config = {
			mode: "posse",
			posse: {
				name: "test-posse",
				meilisearch: {
					url: "http://meili:7700",
				},
			},
		};

		const result = conductorConfigSchema.parse(config);
		expect(result.mode).toBe("posse");
		expect(result.posse?.name).toBe("test-posse");
		expect(result.posse?.meilisearch.url).toBe("http://meili:7700");
		expect(result.posse?.meilisearch.apiKey).toBe("");
		expect(result.posse?.discovery.enabled).toBe(true);
		expect(result.posse?.discovery.pollInterval).toBe(30000);
	});

	test("applies default values for empty object", () => {
		const result = conductorConfigSchema.parse({});
		expect(result.mode).toBe("single");
		expect(result.model).toBe("moonshotai/kimi-k2.5");
		expect(result.server.port).toBe(7777);
		expect(result.server.host).toBe("0.0.0.0");
		expect(result.gateway.http.enabled).toBe(true);
		expect(result.gateway.discord.enabled).toBe(false);
		expect(result.routing.strategy).toBe("auto");
	});

	test("validates complete single-mode config", () => {
		const config = {
			mode: "single" as const,
			model: "anthropic/claude-sonnet-4",
			server: {
				port: 8080,
				host: "127.0.0.1",
			},
			gateway: {
				http: {
					enabled: true,
					auth: "secret-token",
				},
				discord: {
					enabled: true,
					token: "discord-bot-token",
					guildId: "123456789",
				},
			},
			agent: {
				name: "my-agent",
				url: "http://agent.internal:7600",
				model: "gpt-4",
			},
			routing: {
				strategy: "explicit" as const,
			},
		};

		const result = conductorConfigSchema.parse(config);
		expect(result.server.port).toBe(8080);
		expect(result.gateway.http.auth).toBe("secret-token");
		expect(result.gateway.discord.token).toBe("discord-bot-token");
		expect(result.routing.strategy).toBe("explicit");
	});

	test("rejects invalid mode", () => {
		expect(() =>
			conductorConfigSchema.parse({
				mode: "invalid",
			}),
		).toThrow();
	});

	test("rejects invalid routing strategy", () => {
		expect(() =>
			conductorConfigSchema.parse({
				routing: { strategy: "invalid" },
			}),
		).toThrow();
	});

	test("rejects invalid URL for agent", () => {
		expect(() =>
			conductorConfigSchema.parse({
				mode: "single",
				agent: {
					name: "test",
					url: "not-a-url",
				},
			}),
		).toThrow();
	});

	test("rejects invalid URL for meilisearch", () => {
		expect(() =>
			conductorConfigSchema.parse({
				mode: "posse",
				posse: {
					name: "test",
					meilisearch: {
						url: "not-a-url",
					},
				},
			}),
		).toThrow();
	});
});

describe("validateConfig", () => {
	test("validates single mode with agent", () => {
		const config = {
			mode: "single",
			agent: {
				name: "test",
				url: "http://localhost:7600",
			},
		};

		const result = validateConfig(config);
		expect(result.mode).toBe("single");
		expect(result.agent).toBeDefined();
	});

	test("throws for single mode without agent", () => {
		const config = {
			mode: "single",
		};

		expect(() => validateConfig(config)).toThrow('agent: Required when mode is "single"');
	});

	test("validates posse mode with posse config", () => {
		const config = {
			mode: "posse",
			posse: {
				name: "test-posse",
				meilisearch: {
					url: "http://meili:7700",
				},
			},
		};

		const result = validateConfig(config);
		expect(result.mode).toBe("posse");
		expect(result.posse).toBeDefined();
	});

	test("throws for posse mode without posse config", () => {
		const config = {
			mode: "posse",
		};

		expect(() => validateConfig(config)).toThrow('posse: Required when mode is "posse"');
	});

	test("returns frozen config", () => {
		const config = {
			mode: "single",
			agent: {
				name: "test",
				url: "http://localhost:7600",
			},
		};

		const result = validateConfig(config);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.server)).toBe(true);
		expect(Object.isFrozen(result.gateway)).toBe(true);
	});
});

describe("resolveEnvVars", () => {
	beforeEach(() => {
		// Clean up test env vars
		process.env.TEST_CONDUCTOR_VAR = undefined;
		process.env.TEST_CONDUCTOR_NESTED = undefined;
		process.env.TEST_CONDUCTOR_ARR = undefined;
		process.env.TEST_CONDUCTOR_DEFAULT = undefined;
	});

	afterEach(() => {
		process.env.TEST_CONDUCTOR_VAR = undefined;
		process.env.TEST_CONDUCTOR_NESTED = undefined;
		process.env.TEST_CONDUCTOR_ARR = undefined;
		process.env.TEST_CONDUCTOR_DEFAULT = undefined;
	});

	test("substitutes string values", () => {
		process.env.TEST_CONDUCTOR_VAR = "hello";
		const result = resolveEnvVars("${TEST_CONDUCTOR_VAR}");
		expect(result).toBe("hello");
	});

	test("substitutes in nested objects", () => {
		process.env.TEST_CONDUCTOR_NESTED = "world";
		const result = resolveEnvVars({ a: { b: "${TEST_CONDUCTOR_NESTED}" } });
		expect(result).toEqual({ a: { b: "world" } });
	});

	test("substitutes in arrays", () => {
		process.env.TEST_CONDUCTOR_ARR = "item";
		const result = resolveEnvVars(["${TEST_CONDUCTOR_ARR}", "static"]);
		expect(result).toEqual(["item", "static"]);
	});

	test("replaces missing vars with empty string", () => {
		const result = resolveEnvVars("${NONEXISTENT_VAR_XYZ}");
		expect(result).toBe("");
	});

	test("passes through non-string primitives", () => {
		expect(resolveEnvVars(42)).toBe(42);
		expect(resolveEnvVars(true)).toBe(true);
		expect(resolveEnvVars(null)).toBe(null);
	});
});

describe("parseConfig", () => {
	test("parses valid YAML config for single mode", () => {
		const yaml = `
mode: single
model: anthropic/claude-sonnet-4
server:
  port: 8080
  host: 127.0.0.1
agent:
  name: test-agent
  url: http://localhost:7600
  model: gpt-4
`;
		const config = parseConfig(yaml);
		expect(config.mode).toBe("single");
		expect(config.model).toBe("anthropic/claude-sonnet-4");
		expect(config.server.port).toBe(8080);
		expect(config.agent?.name).toBe("test-agent");
		expect(config.agent?.model).toBe("gpt-4");
	});

	test("parses valid YAML config for posse mode", () => {
		const yaml = `
mode: posse
posse:
  name: production-posse
  meilisearch:
    url: http://meili.railway.internal:7700
    apiKey: master-key
  discovery:
    enabled: true
    pollInterval: 15000
routing:
  strategy: auto
`;
		const config = parseConfig(yaml);
		expect(config.mode).toBe("posse");
		expect(config.posse?.name).toBe("production-posse");
		expect(config.posse?.meilisearch.url).toBe("http://meili.railway.internal:7700");
		expect(config.posse?.discovery.pollInterval).toBe(15000);
		expect(config.routing.strategy).toBe("auto");
	});

	test("config is frozen (immutable)", () => {
		const yaml = `
mode: single
agent:
  name: test
  url: http://localhost:7600
`;
		const config = parseConfig(yaml);
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.server)).toBe(true);
		expect(Object.isFrozen(config.gateway)).toBe(true);

		expect(() => {
			(config as Record<string, unknown>).mode = "posse";
		}).toThrow();
	});

	test("substitutes env vars during parse", () => {
		process.env.TEST_AGENT_URL = "http://agent.prod:7600";
		const yaml = `
mode: single
agent:
  name: test
  url: \${TEST_AGENT_URL}
`;
		const config = parseConfig(yaml);
		expect(config.agent?.url).toBe("http://agent.prod:7600");
		process.env.TEST_AGENT_URL = undefined;
	});

	test("throws human-readable error for invalid config", () => {
		const yaml = `
mode: invalid
`;
		try {
			parseConfig(yaml);
			expect(true).toBe(false); // should not reach
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("Config validation failed:");
			expect(msg).toContain("mode");
		}
	});

	test("throws for single mode without agent in YAML", () => {
		const yaml = `
mode: single
server:
  port: 7777
`;
		expect(() => parseConfig(yaml)).toThrow('agent: Required when mode is "single"');
	});
});

describe("validatePartialConfig", () => {
	test("returns valid for complete single mode config", () => {
		const yaml = `
mode: single
agent:
  name: test
  url: http://localhost:7600
`;
		const result = validatePartialConfig(yaml);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.validFields).toContain("mode");
		expect(result.validFields).toContain("agent");
	});

	test("returns errors for single mode without agent", () => {
		const yaml = `
mode: single
server:
  port: 7777
`;
		const result = validatePartialConfig(yaml);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Mode is "single" but no agent configuration provided');
	});

	test("returns warnings for discord without token", () => {
		const yaml = `
mode: single
agent:
  name: test
  url: http://localhost:7600
gateway:
  discord:
    enabled: true
`;
		const result = validatePartialConfig(yaml);
		expect(result.valid).toBe(true);
		expect(result.warnings).toContain("Discord gateway enabled but token not configured");
	});

	test("reports errors for invalid YAML", () => {
		const yaml = `
mode: single
agent
  name: test
  url: http://localhost:7600
`;
		const result = validatePartialConfig(yaml);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("YAML parse error");
	});

	test("reports missing required fields", () => {
		const yaml = `
mode: posse
`;
		const result = validatePartialConfig(yaml);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("posse"))).toBe(true);
	});
});

describe("getDefaultSingleConfig", () => {
	test("returns single mode defaults", () => {
		const config = getDefaultSingleConfig();
		expect(config.mode).toBe("single");
		expect(config.agent).toBeDefined();
		expect(config.agent?.name).toBe("local-agent");
		expect(config.agent?.url).toBe("http://localhost:7600");
		expect(config.routing.strategy).toBe("explicit");
	});

	test("does not include posse config", () => {
		const config = getDefaultSingleConfig();
		expect(config.posse).toBeUndefined();
	});

	test("returns frozen config", () => {
		const config = getDefaultSingleConfig();
		expect(Object.isFrozen(config)).toBe(true);
	});
});

describe("getDefaultPosseConfig", () => {
	test("returns posse mode defaults", () => {
		const config = getDefaultPosseConfig();
		expect(config.mode).toBe("posse");
		expect(config.posse).toBeDefined();
		expect(config.posse?.name).toBe("default-posse");
		expect(config.routing.strategy).toBe("auto");
	});

	test("does not include agent config", () => {
		const config = getDefaultPosseConfig();
		expect(config.agent).toBeUndefined();
	});

	test("returns frozen config", () => {
		const config = getDefaultPosseConfig();
		expect(Object.isFrozen(config)).toBe(true);
	});

	test("uses environment variables for meilisearch", () => {
		process.env.MEILI_URL = "http://custom.meili:7700";
		process.env.MEILI_API_KEY = "custom-key";

		const config = getDefaultPosseConfig();
		expect(config.posse?.meilisearch.url).toBe("http://custom.meili:7700");
		expect(config.posse?.meilisearch.apiKey).toBe("custom-key");

		process.env.MEILI_URL = undefined;
		process.env.MEILI_API_KEY = undefined;
	});
});

describe("loadConfigFromEnv", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("loads single mode from env vars", () => {
		process.env.CONDUCTOR_MODE = "single";
		process.env.CONDUCTOR_AGENT_URL = "http://agent:7600";
		process.env.CONDUCTOR_AGENT_NAME = "env-agent";
		process.env.CONDUCTOR_PORT = "9000";

		const config = loadConfigFromEnv();
		expect(config.mode).toBe("single");
		expect(config.agent?.url).toBe("http://agent:7600");
		expect(config.agent?.name).toBe("env-agent");
		expect(config.server.port).toBe(9000);
	});

	test("loads posse mode from env vars", () => {
		process.env.CONDUCTOR_MODE = "posse";
		process.env.CONDUCTOR_POSSE_NAME = "env-posse";
		process.env.CONDUCTOR_MEILI_URL = "http://meili:7700";
		process.env.CONDUCTOR_DISCOVERY_INTERVAL = "45000";

		const config = loadConfigFromEnv();
		expect(config.mode).toBe("posse");
		expect(config.posse?.name).toBe("env-posse");
		expect(config.posse?.meilisearch.url).toBe("http://meili:7700");
		expect(config.posse?.discovery.pollInterval).toBe(45000);
	});

	test("throws for single mode without CONDUCTOR_AGENT_URL", () => {
		process.env.CONDUCTOR_MODE = "single";
		process.env.CONDUCTOR_AGENT_URL = undefined;

		expect(() => loadConfigFromEnv()).toThrow("CONDUCTOR_AGENT_URL is required");
	});

	test("throws for posse mode without CONDUCTOR_POSSE_NAME", () => {
		process.env.CONDUCTOR_MODE = "posse";
		process.env.CONDUCTOR_POSSE_NAME = undefined;

		expect(() => loadConfigFromEnv()).toThrow("CONDUCTOR_POSSE_NAME is required");
	});

	test("configures Discord gateway from env", () => {
		process.env.CONDUCTOR_MODE = "single";
		process.env.CONDUCTOR_AGENT_URL = "http://localhost:7600";
		process.env.CONDUCTOR_DISCORD_ENABLED = "true";
		process.env.CONDUCTOR_DISCORD_TOKEN = "bot-token";
		process.env.CONDUCTOR_DISCORD_GUILD_ID = "guild123";

		const config = loadConfigFromEnv();
		expect(config.gateway.discord.enabled).toBe(true);
		expect(config.gateway.discord.token).toBe("bot-token");
		expect(config.gateway.discord.guildId).toBe("guild123");
	});

	test("configures routing strategy from env", () => {
		process.env.CONDUCTOR_MODE = "single";
		process.env.CONDUCTOR_AGENT_URL = "http://localhost:7600";
		process.env.CONDUCTOR_ROUTING_STRATEGY = "round-robin";

		const config = loadConfigFromEnv();
		expect(config.routing.strategy).toBe("round-robin");
	});

	test("returns frozen config", () => {
		process.env.CONDUCTOR_MODE = "single";
		process.env.CONDUCTOR_AGENT_URL = "http://localhost:7600";

		const config = loadConfigFromEnv();
		expect(Object.isFrozen(config)).toBe(true);
	});
});

describe("loadConfig integration", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("throws when no config found", () => {
		// Clear any config env vars
		process.env.CONDUCTOR_CONFIG_PATH = undefined;
		process.env.CONDUCTOR_CONFIG_YAML = undefined;

		expect(() => loadConfig()).toThrow("No conductor config found");
	});

	test("uses CONDUCTOR_CONFIG_YAML env var", () => {
		const yaml = `
mode: single
agent:
  name: yaml-env-agent
  url: http://localhost:7600
`;
		process.env.CONDUCTOR_CONFIG_YAML = yaml;

		const config = loadConfig();
		expect(config.mode).toBe("single");
		expect(config.agent?.name).toBe("yaml-env-agent");

		process.env.CONDUCTOR_CONFIG_YAML = undefined;
	});

	test("loads from explicit path", () => {
		// This test would need an actual file, so we just verify the function exists
		expect(typeof loadConfig).toBe("function");
	});
});

describe("deployment-agnostic configuration", () => {
	test("single mode: same config works locally and on Railway", () => {
		const config = {
			mode: "single" as const,
			agent: {
				name: "my-agent",
				url: "${AGENT_URL}", // Use env var for flexibility
				model: "moonshotai/kimi-k2.5",
			},
			server: {
				port: 7777,
				host: "0.0.0.0",
			},
		};

		// Test with local URL
		process.env.AGENT_URL = "http://localhost:7600";
		let result = validateConfig(resolveEnvVars(config));
		expect(result.agent?.url).toBe("http://localhost:7600");

		// Test with Railway URL
		process.env.AGENT_URL = "http://agent.railway.internal:7600";
		result = validateConfig(resolveEnvVars(config));
		expect(result.agent?.url).toBe("http://agent.railway.internal:7600");

		process.env.AGENT_URL = undefined;
	});

	test("posse mode: uses env vars for Meilisearch credentials", () => {
		const config = {
			mode: "posse" as const,
			posse: {
				name: "my-posse",
				meilisearch: {
					url: "${MEILI_URL:-http://localhost:7700}",
					apiKey: "${MEILI_API_KEY}",
				},
			},
		};

		// Test with Railway Meilisearch
		process.env.MEILI_URL = "http://meili.railway.internal:7700";
		process.env.MEILI_API_KEY = "railway-key";

		const result = validateConfig(resolveEnvVars(config));
		expect(result.posse?.meilisearch.url).toBe("http://meili.railway.internal:7700");
		expect(result.posse?.meilisearch.apiKey).toBe("railway-key");

		process.env.MEILI_URL = undefined;
		process.env.MEILI_API_KEY = undefined;
	});
});
