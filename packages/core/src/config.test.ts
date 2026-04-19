import { describe, expect, test } from "bun:test";
import {
	configSchema,
	formatZodError,
	loadConfig,
	mergePartialConfig,
	parseConfig,
	substituteEnvVars,
	validatePartialConfig,
} from "./config.js";

describe("configSchema", () => {
	const minimalConfig = {
		name: "test-agent",
		runner: {
			workdir: "/tmp/test",
		},
	};

	test("validates minimal config with defaults", () => {
		const result = configSchema.parse(minimalConfig);
		expect(result.name).toBe("test-agent");
		expect(result.version).toBe("0.1");
		expect(result.runner.defaultAgent).toBe("opencode");
		expect(result.runner.defaultModel).toBe("anthropic/claude-sonnet-4");
		expect(result.runner.defaultMaxIterations).toBe(20);
		expect(result.runner.completionPromise).toBe("DONE");
		expect(result.runner.struggle.noChangeThreshold).toBe(3);
		expect(result.runner.struggle.maxRepeatedErrors).toBe(3);
		expect(result.credentials.envFile).toBe("./.env");
		expect(result.credentials.inherit).toEqual(["PATH", "HOME", "USER", "SHELL", "TERM"]);
		expect(result.memory.store).toBe("meilisearch");
		expect(result.memory.url).toBe("http://localhost:7701");
		expect(result.memory.apiKey).toBe("");
		expect(result.memory.autoInject.enabled).toBe(true);
		expect(result.memory.autoInject.maxResults).toBe(5);
		expect(result.tools).toEqual([]);
		expect(result.identity.knowledge).toEqual([]);
		expect(result.identity.rules).toEqual([]);
		expect(result.identity.vars).toEqual({});
	});

	test("rejects config without name", () => {
		expect(() => configSchema.parse({ runner: { workdir: "/tmp" } })).toThrow();
	});

	test("rejects config without runner.workdir", () => {
		expect(() => configSchema.parse({ name: "test" })).toThrow();
	});

	test("validates full config", () => {
		const full = {
			name: "support-agent",
			version: "0.1",
			posse: "support-team",
			identity: {
				persona: "You are a support agent",
				systemPrompt: "Write learnings to MEMORY.md",
				knowledge: ["./knowledge/*.md"],
				rules: ["NEVER delete data", "ALWAYS verify"],
			},
			runner: {
				defaultAgent: "opencode",
				defaultModel: "claude-sonnet-4",
				defaultMaxIterations: 10,
				workdir: "/home/node/workspace",
				allowedWorkdirs: ["/home/node/workspace"],
				completionPromise: "DONE",
				struggle: {
					noChangeThreshold: 5,
					maxRepeatedErrors: 4,
				},
			},
			credentials: {
				envFile: "./.env",
				allow: ["ANTHROPIC_API_KEY", "SUPABASE_URL"],
				inherit: ["PATH", "HOME"],
			},
			gateway: {
				channels: [{ type: "http" as const, port: 7600, auth: "secret" }],
			},
			memory: {
				url: "http://localhost:7701",
				apiKey: "master-key",
				index: "memory-support",
				embedder: { type: "builtin" as const },
				sharing: {
					publishTo: "shared",
					readFrom: ["shared"],
				},
				autoInject: {
					enabled: true,
					maxResults: 10,
				},
			},
			tools: [
				{
					name: "steer",
					binary: "steer",
					skill: "./skills/steer.md",
					platforms: ["darwin" as const],
				},
			],
			tracking: {
				tokenPricing: {
					"claude-sonnet-4": { input: 3.0, output: 15.0 },
				},
			},
		};

		const result = configSchema.parse(full);
		expect(result.name).toBe("support-agent");
		expect(result.posse).toBe("support-team");
		expect(result.identity.rules).toHaveLength(2);
		expect(result.runner.defaultAgent).toBe("opencode");
		expect(result.gateway.channels).toHaveLength(1);
		expect(result.tools).toHaveLength(1);
	});

	test("validates identity.vars as Record<string, string>", () => {
		const result = configSchema.parse({
			...minimalConfig,
			identity: {
				persona: "Test agent",
				vars: {
					name: "my-agent",
					company: "Acme Corp",
					environment: "production",
				},
			},
		});
		expect(result.identity.vars).toEqual({
			name: "my-agent",
			company: "Acme Corp",
			environment: "production",
		});
	});

	test("identity.vars defaults to empty object", () => {
		const result = configSchema.parse({
			...minimalConfig,
			identity: {
				persona: "Test agent",
			},
		});
		expect(result.identity.vars).toEqual({});
	});

	test("validates discord channel", () => {
		const config = {
			...minimalConfig,
			gateway: {
				channels: [
					{
						type: "discord" as const,
						token: "bot-token",
						allowFrom: ["user1"],
					},
				],
			},
		};
		const result = configSchema.parse(config);
		expect(result.gateway.channels[0].type).toBe("discord");
	});

	test("validates imessage channel", () => {
		const config = {
			...minimalConfig,
			gateway: {
				channels: [
					{
						type: "imessage" as const,
						provider: "bluebubbles" as const,
						url: "http://localhost:1234",
						password: "secret",
					},
				],
			},
		};
		const result = configSchema.parse(config);
		expect(result.gateway.channels[0].type).toBe("imessage");
	});

	test("validates voice access defaults and overrides", () => {
		const config = {
			...minimalConfig,
			gateway: {
				channels: [
					{
						type: "voice" as const,
						allowFrom: ["+15551111111"],
						access: {
							trustedCallers: ["+15552222222"],
							unknownInbound: "external" as const,
							defaultExternalGrants: ["memory", "scheduler"],
						},
					},
				],
			},
		};
		const result = configSchema.parse(config);
		expect(result.gateway.channels[0].type).toBe("voice");
		if (result.gateway.channels[0].type !== "voice") {
			throw new Error("expected voice channel");
		}
		expect(result.gateway.channels[0].access.unknownInbound).toBe("external");
		expect(result.gateway.channels[0].access.defaultExternalGrants).toEqual([
			"memory",
			"scheduler",
		]);
	});

	test("validates embedder variants", () => {
		const configs = [
			{ type: "builtin" as const },
			{
				type: "openai" as const,
				model: "text-embedding-3-large",
				apiKey: "key",
			},
			{
				type: "openrouter" as const,
				model: "openai/text-embedding-3-large",
				apiKey: "key",
			},
			{
				type: "ollama" as const,
				model: "nomic-embed-text",
				url: "http://localhost:11434",
			},
		];

		for (const embedder of configs) {
			const result = configSchema.parse({
				...minimalConfig,
				memory: { embedder },
			});
			expect(result.memory.embedder.type).toBe(embedder.type);
		}
	});
});

describe("substituteEnvVars", () => {
	test("substitutes string values", () => {
		process.env.TEST_VAR = "hello";
		expect(substituteEnvVars("${TEST_VAR}")).toBe("hello");
		process.env.TEST_VAR = undefined;
	});

	test("substitutes in nested objects", () => {
		process.env.TEST_NESTED = "world";
		const result = substituteEnvVars({ a: { b: "${TEST_NESTED}" } });
		expect(result).toEqual({ a: { b: "world" } });
		process.env.TEST_NESTED = undefined;
	});

	test("substitutes in arrays", () => {
		process.env.TEST_ARR = "item";
		const result = substituteEnvVars(["${TEST_ARR}", "static"]);
		expect(result).toEqual(["item", "static"]);
		process.env.TEST_ARR = undefined;
	});

	test("replaces missing vars with empty string", () => {
		expect(substituteEnvVars("${NONEXISTENT_VAR_XYZ}")).toBe("");
	});

	test("passes through non-string primitives", () => {
		expect(substituteEnvVars(42)).toBe(42);
		expect(substituteEnvVars(true)).toBe(true);
		expect(substituteEnvVars(null)).toBe(null);
	});
});

describe("scheduler config sections", () => {
	const minimalConfig = {
		name: "test-agent",
		runner: {
			workdir: "/tmp/test",
		},
	};

	test("heartbeat defaults when not specified", () => {
		const result = configSchema.parse(minimalConfig);
		expect(result.heartbeat.enabled).toBe(false);
		expect(result.heartbeat.every).toBe("30m");
		expect(result.heartbeat.prompt).toBe("./HEARTBEAT.md");
		expect(result.heartbeat.target).toBe("none");
		expect(result.heartbeat.activeHours.timezone).toBe("UTC");
		expect(result.heartbeat.model).toBeUndefined();
	});

	test("heartbeat with custom values", () => {
		const result = configSchema.parse({
			...minimalConfig,
			heartbeat: {
				enabled: true,
				every: "15m",
				prompt: "./custom-heartbeat.md",
				activeHours: {
					start: "08:00",
					end: "22:00",
					timezone: "America/Denver",
				},
				target: "slack",
				model: "anthropic/claude-haiku-4",
			},
		});
		expect(result.heartbeat.enabled).toBe(true);
		expect(result.heartbeat.every).toBe("15m");
		expect(result.heartbeat.prompt).toBe("./custom-heartbeat.md");
		expect(result.heartbeat.activeHours.start).toBe("08:00");
		expect(result.heartbeat.activeHours.end).toBe("22:00");
		expect(result.heartbeat.activeHours.timezone).toBe("America/Denver");
		expect(result.heartbeat.target).toBe("slack");
		expect(result.heartbeat.model).toBe("anthropic/claude-haiku-4");
	});

	test("cron defaults when not specified", () => {
		const result = configSchema.parse(minimalConfig);
		expect(result.cron.jobs).toEqual({});
	});

	test("cron with cron expression schedule", () => {
		const result = configSchema.parse({
			...minimalConfig,
			cron: {
				jobs: {
					"morning-briefing": {
						schedule: "0 7 * * *",
						prompt: "Morning briefing",
						execution: "isolated",
						announce: true,
					},
				},
			},
		});
		const job = result.cron.jobs["morning-briefing"];
		expect(job).toBeDefined();
		expect(job.schedule).toBe("0 7 * * *");
		expect(job.prompt).toBe("Morning briefing");
		expect(job.execution).toBe("isolated");
		expect(job.announce).toBe(true);
	});

	test("cron with interval schedule", () => {
		const result = configSchema.parse({
			...minimalConfig,
			cron: {
				jobs: {
					"periodic-check": {
						schedule: { every: "30m" },
						prompt: "Check status",
					},
				},
			},
		});
		const job = result.cron.jobs["periodic-check"];
		expect(job).toBeDefined();
		expect(job.schedule).toEqual({ every: "30m" });
		expect(job.execution).toBe("isolated"); // default
		expect(job.announce).toBe(false); // default
	});

	test("cron with one-shot schedule", () => {
		const result = configSchema.parse({
			...minimalConfig,
			cron: {
				jobs: {
					"one-time": {
						schedule: { at: "2026-03-15T14:00:00Z" },
						prompt: "One-time task",
					},
				},
			},
		});
		const job = result.cron.jobs["one-time"];
		expect(job).toBeDefined();
		expect(job.schedule).toEqual({ at: "2026-03-15T14:00:00Z" });
	});

	test("cron with multiple jobs", () => {
		const result = configSchema.parse({
			...minimalConfig,
			cron: {
				jobs: {
					"job-a": {
						schedule: "0 8 * * *",
						prompt: "Job A",
					},
					"job-b": {
						schedule: { every: "1h" },
						prompt: "Job B",
						execution: "main",
					},
					"job-c": {
						schedule: { at: "2026-12-31T23:59:00Z" },
						prompt: "Job C",
						model: "anthropic/claude-haiku-4",
					},
				},
			},
		});
		expect(Object.keys(result.cron.jobs)).toHaveLength(3);
	});

	test("hooks defaults when not specified", () => {
		const result = configSchema.parse(minimalConfig);
		expect(result.hooks.enabled).toBe(false);
		expect(result.hooks.token).toBeUndefined();
		expect(result.hooks.path).toBe("/hooks");
	});

	test("hooks with custom values", () => {
		const result = configSchema.parse({
			...minimalConfig,
			hooks: {
				enabled: true,
				token: "secret-token",
				path: "/webhooks",
			},
		});
		expect(result.hooks.enabled).toBe(true);
		expect(result.hooks.token).toBe("secret-token");
		expect(result.hooks.path).toBe("/webhooks");
	});

	test("config with all scheduler sections validates", () => {
		const result = configSchema.parse({
			...minimalConfig,
			heartbeat: {
				enabled: true,
				every: "30m",
				prompt: "Check in",
			},
			cron: {
				jobs: {
					daily: {
						schedule: "0 8 * * *",
						prompt: "Daily task",
					},
				},
			},
			hooks: {
				enabled: true,
				token: "test-token",
			},
		});
		expect(result.heartbeat.enabled).toBe(true);
		expect(Object.keys(result.cron.jobs)).toHaveLength(1);
		expect(result.hooks.enabled).toBe(true);
	});

	test("partial scheduler config fills defaults", () => {
		const result = configSchema.parse({
			...minimalConfig,
			heartbeat: { enabled: true },
			// cron and hooks not specified — should default
		});
		expect(result.heartbeat.enabled).toBe(true);
		expect(result.heartbeat.every).toBe("30m");
		expect(result.cron.jobs).toEqual({});
		expect(result.hooks.enabled).toBe(false);
	});
});

describe("parseConfig", () => {
	test("parses valid YAML config", () => {
		const yaml = `
name: test-agent
runner:
  workdir: /tmp/test
`;
		const config = parseConfig(yaml);
		expect(config.name).toBe("test-agent");
		expect(config.runner.workdir).toBe("/tmp/test");
	});

	test("config is frozen (immutable)", () => {
		const yaml = `
name: test-agent
runner:
  workdir: /tmp/test
`;
		const config = parseConfig(yaml);
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.runner)).toBe(true);
		expect(Object.isFrozen(config.identity)).toBe(true);
		expect(Object.isFrozen(config.credentials)).toBe(true);
		expect(Object.isFrozen(config.memory)).toBe(true);

		expect(() => {
			(config as Record<string, unknown>).name = "changed";
		}).toThrow();
	});

	test("substitutes env vars during parse", () => {
		process.env.TEST_PORT_VAL = "8080";
		const yaml = `
name: test
runner:
  workdir: /tmp
gateway:
  channels:
    - type: http
      port: 7600
      auth: "\${TEST_PORT_VAL}"
`;
		const config = parseConfig(yaml);
		const httpChannel = config.gateway.channels[0];
		expect(httpChannel.type).toBe("http");
		if (httpChannel.type === "http") {
			expect(httpChannel.auth).toBe("8080");
		}
		process.env.TEST_PORT_VAL = undefined;
	});
});

describe("mergePartialConfig", () => {
	test("fills defaults for minimal input", () => {
		const result = mergePartialConfig({
			name: "test",
			runner: { workdir: "." },
		});
		expect(result.name).toBe("test");
		expect(result.runner.workdir).toBe(".");
		expect(result.runner.defaultAgent).toBe("opencode");
		expect(result.runner.defaultModel).toBe("anthropic/claude-sonnet-4");
		expect(result.credentials.envFile).toBe("./.env");
		expect(result.heartbeat.enabled).toBe(false);
		expect(result.cron.jobs).toEqual({});
		expect(result.hooks.enabled).toBe(false);
	});

	test("preserves provided values", () => {
		const result = mergePartialConfig({
			name: "custom",
			runner: { workdir: "/opt/work", defaultAgent: "opencode" },
			heartbeat: { enabled: true, every: "15m" },
		});
		expect(result.name).toBe("custom");
		expect(result.runner.defaultAgent).toBe("opencode");
		expect(result.heartbeat.enabled).toBe(true);
		expect(result.heartbeat.every).toBe("15m");
	});
});

describe("validatePartialConfig", () => {
	test("returns valid for complete config", () => {
		const yaml = `
name: test-agent
runner:
  workdir: /tmp/test
`;
		const result = validatePartialConfig(yaml);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.validFields).toContain("name");
		expect(result.validFields).toContain("runner");
	});

	test("reports errors for missing required fields", () => {
		const yaml = `
version: "0.1"
`;
		const result = validatePartialConfig(yaml);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("reports missing name", () => {
		const yaml = `
runner:
  workdir: /tmp
`;
		const result = validatePartialConfig(yaml);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("name"))).toBe(true);
	});
});

describe("loadConfig env var support", () => {
	test("loadConfig uses RANDAL_CONFIG_YAML env var", () => {
		const yaml = "name: env-test\nrunner:\n  workdir: /tmp";
		process.env.RANDAL_CONFIG_YAML = yaml;

		// Clear any config path env to ensure we hit the YAML env
		const savedPath = process.env.RANDAL_CONFIG_PATH;
		process.env.RANDAL_CONFIG_PATH = undefined;

		try {
			const config = loadConfig();
			expect(config.name).toBe("env-test");
		} finally {
			process.env.RANDAL_CONFIG_YAML = undefined;
			process.env.RANDAL_CONFIG_PATH = savedPath;
		}
	});

	test("loadConfig throws for nonexistent explicit path", () => {
		expect(() => {
			loadConfig("/nonexistent/path/that/does/not/exist.yaml");
		}).toThrow();
	});
});

describe("formatZodError", () => {
	test("formats missing required field", () => {
		const result = configSchema.safeParse({ name: "test" });
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = formatZodError(result.error);
			expect(msg).toContain("Config validation failed:");
			expect(msg).toContain("runner");
			expect(msg).toContain("Required");
		}
	});

	test("formats invalid_type with expected vs received", () => {
		const result = configSchema.safeParse({
			name: 123, // should be string
			runner: { workdir: "/tmp" },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = formatZodError(result.error);
			expect(msg).toContain("expected string, got number");
		}
	});

	test("formats invalid_enum_value with valid options", () => {
		const result = configSchema.safeParse({
			name: "test",
			runner: { workdir: "/tmp", defaultAgent: "invalid-agent" },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = formatZodError(result.error);
			expect(msg).toContain("runner.defaultAgent");
			expect(msg).toContain("valid:");
			expect(msg).toContain("opencode");
			expect(msg).toContain("mock");
		}
	});

	test("formats multiple errors", () => {
		const result = configSchema.safeParse({});
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = formatZodError(result.error);
			const lines = msg.split("\n").filter((l) => l.startsWith("  - "));
			expect(lines.length).toBeGreaterThanOrEqual(2);
		}
	});

	test("formats nested path with dotted notation", () => {
		const result = configSchema.safeParse({
			name: "test",
			runner: { workdir: "/tmp", struggle: { action: "invalid" } },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = formatZodError(result.error);
			expect(msg).toContain("runner.struggle.action");
		}
	});
});

describe("mesh config schema", () => {
	const minimalConfig = {
		name: "test-agent",
		runner: {
			workdir: "/tmp/test",
		},
	};

	test("validates mesh.role with valid domain slug", () => {
		const result = configSchema.parse({
			...minimalConfig,
			mesh: { role: "product-engineering" },
		});
		expect(result.mesh.role).toBe("product-engineering");
	});

	test("rejects mesh.role with invalid domain slug", () => {
		expect(() =>
			configSchema.parse({
				...minimalConfig,
				mesh: { role: "invalid-domain" },
			}),
		).toThrow();
	});

	test("validates mesh.expertise as inline string", () => {
		const result = configSchema.parse({
			...minimalConfig,
			mesh: { expertise: "Expert in React and TypeScript" },
		});
		expect(result.mesh.expertise).toBe("Expert in React and TypeScript");
	});

	test("validates mesh.expertise as file reference object", () => {
		const result = configSchema.parse({
			...minimalConfig,
			mesh: { expertise: { file: "./profiles/eng.md" } },
		});
		expect(result.mesh.expertise).toEqual({ file: "./profiles/eng.md" });
	});

	test("validates mesh.expertise as file reference with additional", () => {
		const result = configSchema.parse({
			...minimalConfig,
			mesh: {
				expertise: { file: "./profiles/eng.md", additional: "Also knows billing" },
			},
		});
		expect(result.mesh.expertise).toEqual({
			file: "./profiles/eng.md",
			additional: "Also knows billing",
		});
	});

	test("defaults routing weight expertise to 0.4", () => {
		const result = configSchema.parse(minimalConfig);
		expect(result.mesh.routingWeights.expertise).toBe(0.4);
	});
});

describe("config error integration", () => {
	test("parseConfig throws human-readable error, not JSON", () => {
		const badYaml = "name: 123\n";
		try {
			parseConfig(badYaml);
			expect(true).toBe(false); // should not reach
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("Config validation failed:");
			expect(msg).not.toContain('"code"');
			expect(msg).not.toContain('"path"');
		}
	});

	test("mergePartialConfig throws human-readable error", () => {
		try {
			mergePartialConfig({ name: 123 as unknown as string });
			expect(true).toBe(false); // should not reach
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("Config validation failed:");
		}
	});
});
