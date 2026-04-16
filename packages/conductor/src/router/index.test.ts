/**
 * Tests for Task Router
 *
 * @module router/index.test
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
	TaskRouter,
	createTaskRouter,
	createHttpAgentClient,
	HttpAgentClient,
	RoutingError,
	NoHealthyAgentsError,
	AgentNotFoundError,
} from './index.ts';
import type { ConductorConfig } from '../config.ts';
import type { AgentRegistry, EnrichedAgentRecord } from '../agents/registry.ts';
import type { Task, AgentResponse } from './index.ts';

// ============================================================================
// Mock Types
// ============================================================================

interface MockAgentRegistry extends AgentRegistry {
	addAgent: (a: EnrichedAgentRecord) => void;
	clear: () => void;
}

// ============================================================================
// Mock Registry Factory
// ============================================================================

function createMockRegistry(): MockAgentRegistry {
	const agents = new Map<string, EnrichedAgentRecord>();

	const registry = {
		getAllAgents: () => Array.from(agents.values()),
		getAgent: (name: string) => agents.get(name),
		getHealthyAgents: () => {
			const all = Array.from(agents.values());
			return all.filter(
				(a: EnrichedAgentRecord) => a.health.isResponsive
			);
		},
		getStats: () => ({
			total: agents.size,
			online: Array.from(agents.values()).filter((a: EnrichedAgentRecord) => a.health.status === 'healthy').length,
			offline: 0,
			busy: Array.from(agents.values()).filter((a: EnrichedAgentRecord) => a.health.status === 'busy').length,
			error: 0,
		}),
		getPosseName: () => 'test-posse',
		isActive: true,
		startPolling: () => {},
		stopPolling: () => {},
		refresh: async () => {},
		getAgentsByRole: () => [],
		getAgentsByCapability: () => [],
		getAgentsByModel: () => [],
		on: () => {},
		off: () => {},
		initialize: async () => {},
		addAgent: (agent: EnrichedAgentRecord) => {
			agents.set(agent.name, agent);
		},
		clear: () => agents.clear(),
	} as unknown as MockAgentRegistry;

	return registry;
}

// ============================================================================
// Mock Agent Client
// ============================================================================

class MockAgentClient {
	private responses: Map<string, AgentResponse> = new Map();
	private shouldFail = false;
	private failWithError?: string;

	setResponse(taskId: string, response: AgentResponse): void {
		this.responses.set(taskId, response);
	}

	setShouldFail(fail: boolean, error?: string): void {
		this.shouldFail = fail;
		this.failWithError = error;
	}

	async sendTask(_endpoint: string, task: Task): Promise<AgentResponse> {
		if (this.shouldFail) {
			throw new Error(this.failWithError ?? 'Mock client error');
		}

		const response = this.responses.get(task.id);
		if (response) {
			return response;
		}

		return {
			success: true,
			content: `Response for task ${task.id}`,
			metadata: {},
		};
	}
}

// ============================================================================
// Test Helpers
// ============================================================================

function createMockAgent(name: string, status: 'online' | 'offline' | 'busy' = 'online'): EnrichedAgentRecord {
	const now = new Date().toISOString();
	const healthStatus: 'healthy' | 'busy' | 'stale' | 'offline' =
		status === 'busy' ? 'busy' : status === 'offline' ? 'offline' : 'healthy';

	return {
		id: name,
		name,
		endpoint: `http://localhost:7600/${name}`,
		models: ['moonshotai/kimi-k2.5'],
		capabilities: ['chat', 'code'],
		status,
		lastSeen: now,
		version: '0.1.0',
		metadata: { role: 'product-engineering' },
		health: {
			status: healthStatus,
			lastSeen: now,
			isResponsive: status !== 'offline',
			msSinceLastHeartbeat: 1000,
		},
	};
}

function createMockTask(overrides: Partial<Task> = {}): Task {
	return {
		id: overrides.id ?? 'task-1',
		content: overrides.content ?? 'Test task content',
		channel: overrides.channel ?? 'test',
		userId: overrides.userId ?? 'user-1',
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		explicitAgent: overrides.explicitAgent,
		metadata: overrides.metadata,
		...overrides,
	};
}

function createSingleModeConfig(): ConductorConfig {
	return {
		mode: 'single',
		model: 'moonshotai/kimi-k2.5',
		server: { port: 7777, host: '0.0.0.0' },
		gateway: {
			http: { enabled: true },
			discord: { enabled: false },
		},
		agent: {
			name: 'local-agent',
			url: 'http://localhost:7600',
			model: 'moonshotai/kimi-k2.5',
		},
		routing: { strategy: 'explicit' },
	};
}

function createPosseModeConfig(strategy: 'auto' | 'round-robin' | 'explicit' = 'auto'): ConductorConfig {
	return {
		mode: 'posse',
		model: 'moonshotai/kimi-k2.5',
		server: { port: 7777, host: '0.0.0.0' },
		gateway: {
			http: { enabled: true },
			discord: { enabled: false },
		},
		posse: {
			name: 'test-posse',
			meilisearch: { url: 'http://localhost:7700', apiKey: '' },
			discovery: { enabled: true, pollInterval: 30000 },
		},
		routing: { strategy },
	};
}

// ============================================================================
// Test Suite
// ============================================================================

describe('TaskRouter', () => {
	describe('single mode', () => {
		let config: ConductorConfig;
		let mockClient: MockAgentClient;
		let router: TaskRouter;

		beforeEach(() => {
			config = createSingleModeConfig();
			mockClient = new MockAgentClient();
			router = createTaskRouter(config, undefined, mockClient as unknown as ReturnType<typeof createHttpAgentClient>);
		});

		it('should route to single configured agent', async () => {
			mockClient.setResponse('task-1', {
				success: true,
				content: 'Hello from single agent',
			});

			const task = createMockTask({ id: 'task-1' });
			const result = await router.routeTask(task);

			expect(result.success).toBe(true);
			expect(result.content).toBe('Hello from single agent');
			expect(result.agent).toBe('local-agent');
		});

		it('should throw error if no agent configured', async () => {
			config.agent = undefined;

			const task = createMockTask();
			await expect(router.routeTask(task)).rejects.toThrow(RoutingError);
		});

		it('should handle failed agent response', async () => {
			mockClient.setShouldFail(true, 'Connection refused');

			const task = createMockTask({ id: 'task-1' });
			const result = await router.routeTask(task);

			expect(result.success).toBe(false);
			expect(result.agent).toBe('local-agent');
		});
	});

	describe('posse mode - explicit routing', () => {
		let config: ConductorConfig;
		let mockRegistry: MockAgentRegistry;
		let mockClient: MockAgentClient;
		let router: TaskRouter;

		beforeEach(() => {
			config = createPosseModeConfig('explicit');
			mockRegistry = createMockRegistry();
			mockClient = new MockAgentClient();
			router = createTaskRouter(config, mockRegistry, mockClient as unknown as ReturnType<typeof createHttpAgentClient>);
		});

		it('should route to explicitly specified agent', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));
			mockClient.setResponse('task-1', {
				success: true,
				content: 'Hello from agent-1',
			});

			const task = createMockTask({ id: 'task-1', explicitAgent: 'agent-1' });
			const result = await router.routeTask(task);

			expect(result.success).toBe(true);
			expect(result.content).toBe('Hello from agent-1');
			expect(result.agent).toBe('agent-1');
		});

		it('should throw error if no explicit agent specified', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));

			const task = createMockTask({ id: 'task-1' });
			await expect(router.routeTask(task)).rejects.toThrow(RoutingError);
		});

		it('should throw error if agent not found', async () => {
			const task = createMockTask({ id: 'task-1', explicitAgent: 'non-existent' });
			await expect(router.routeTask(task)).rejects.toThrow(AgentNotFoundError);
		});

		it('should throw error if agent is not responsive', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1', 'offline'));

			const task = createMockTask({ id: 'task-1', explicitAgent: 'agent-1' });
			await expect(router.routeTask(task)).rejects.toThrow(RoutingError);
		});
	});

	describe('posse mode - round-robin routing', () => {
		let config: ConductorConfig;
		let mockRegistry: MockAgentRegistry;
		let mockClient: MockAgentClient;
		let router: TaskRouter;

		beforeEach(() => {
			config = createPosseModeConfig('round-robin');
			mockRegistry = createMockRegistry();
			mockClient = new MockAgentClient();
			router = createTaskRouter(config, mockRegistry, mockClient as unknown as ReturnType<typeof createHttpAgentClient>);
		});

		it('should cycle through healthy agents', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));
			mockRegistry.addAgent(createMockAgent('agent-2'));

			// First task
			mockClient.setResponse('task-1', { success: true, content: 'Result 1' });
			const result1 = await router.routeTask(createMockTask({ id: 'task-1' }));

			// Second task
			mockClient.setResponse('task-2', { success: true, content: 'Result 2' });
			const result2 = await router.routeTask(createMockTask({ id: 'task-2' }));

			// Third task (should cycle back)
			mockClient.setResponse('task-3', { success: true, content: 'Result 3' });
			const result3 = await router.routeTask(createMockTask({ id: 'task-3' }));

			// Agents should be different (round-robin)
			expect([result1.agent, result2.agent, result3.agent]).toContain('agent-1');
			expect([result1.agent, result2.agent, result3.agent]).toContain('agent-2');
		});

		it('should throw error if no healthy agents available', async () => {
			const task = createMockTask();
			await expect(router.routeTask(task)).rejects.toThrow(NoHealthyAgentsError);
		});

		it('should skip offline agents', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1', 'offline'));
			mockRegistry.addAgent(createMockAgent('agent-2', 'online'));

			mockClient.setResponse('task-1', { success: true, content: 'Result' });
			const result = await router.routeTask(createMockTask({ id: 'task-1' }));

			expect(result.agent).toBe('agent-2');
		});
	});

	describe('posse mode - auto routing', () => {
		let config: ConductorConfig;
		let mockRegistry: MockAgentRegistry;
		let mockClient: MockAgentClient;
		let router: TaskRouter;

		beforeEach(() => {
			config = createPosseModeConfig('auto');
			mockRegistry = createMockRegistry();
			mockClient = new MockAgentClient();
			router = createTaskRouter(config, mockRegistry, mockClient as unknown as ReturnType<typeof createHttpAgentClient>);
		});

		it('should route to available agent', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));
			mockClient.setResponse('task-1', { success: true, content: 'Result' });

			const result = await router.routeTask(createMockTask({ id: 'task-1' }));

			expect(result.success).toBe(true);
			expect(result.agent).toBe('agent-1');
		});

		it('should use the only available agent', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));
			mockClient.setResponse('task-1', { success: true, content: 'Result' });

			const result = await router.routeTask(createMockTask({ id: 'task-1' }));

			expect(result.agent).toBe('agent-1');
		});

		it('should match task to agent by capability', async () => {
			const codeAgent = createMockAgent('code-agent');
			codeAgent.capabilities = ['code', 'programming'];
			mockRegistry.addAgent(codeAgent);

			mockClient.setResponse('task-1', { success: true, content: 'Code result' });

			const result = await router.routeTask(createMockTask({
				id: 'task-1',
				content: 'Write a function to calculate fibonacci',
			}));

			expect(result.agent).toBe('code-agent');
		});

		it('should fallback to any healthy agent if no capability match', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));
			mockClient.setResponse('task-1', { success: true, content: 'Result' });

			const result = await router.routeTask(createMockTask({ id: 'task-1' }));

			expect(result.agent).toBe('agent-1');
		});
	});

	describe('multi-agent routing', () => {
		let config: ConductorConfig;
		let mockRegistry: MockAgentRegistry;
		let mockClient: MockAgentClient;
		let router: TaskRouter;

		beforeEach(() => {
			config = createPosseModeConfig('explicit');
			mockRegistry = createMockRegistry();
			mockClient = new MockAgentClient();
			router = createTaskRouter(config, mockRegistry, mockClient as unknown as ReturnType<typeof createHttpAgentClient>);
		});

		it('should route to multiple agents in parallel', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));
			mockRegistry.addAgent(createMockAgent('agent-2'));

			mockClient.setResponse('task-1', { success: true, content: 'Result 1' });

			const results = await router.routeToMultiple(
				createMockTask({ id: 'task-1' }),
				['agent-1', 'agent-2']
			);

			expect(results).toHaveLength(2);
			expect(results.every((r) => r.success)).toBe(true);
		});

		it('should handle non-existent agents in multi-agent routing', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));

			const results = await router.routeToMultiple(
				createMockTask({ id: 'task-1' }),
				['agent-1', 'non-existent']
			);

			expect(results).toHaveLength(2);
			expect(results[0].success).toBe(true);
			expect(results[1].success).toBe(false);
			expect(results[1].metadata?.error).toBe('Agent not found');
		});
	});

	describe('error handling', () => {
		let config: ConductorConfig;
		let mockRegistry: MockAgentRegistry;
		let mockClient: MockAgentClient;
		let router: TaskRouter;

		beforeEach(() => {
			config = createPosseModeConfig('auto');
			mockRegistry = createMockRegistry();
			mockClient = new MockAgentClient();
			router = createTaskRouter(config, mockRegistry, mockClient as unknown as ReturnType<typeof createHttpAgentClient>);
		});

		it('should return error result on task failure', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));
			mockClient.setShouldFail(true, 'Agent crashed');

			const result = await router.routeTask(createMockTask({ id: 'task-1' }));

			expect(result.success).toBe(false);
			expect(result.metadata?.error).toContain('Agent crashed');
		});

		it('should track duration on error', async () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));
			mockClient.setShouldFail(true);

			const result = await router.routeTask(createMockTask({ id: 'task-1' }));

			expect(result.duration).toBeGreaterThanOrEqual(0);
		});
	});

	describe('getters', () => {
		let config: ConductorConfig;
		let mockRegistry: MockAgentRegistry;
		let router: TaskRouter;

		beforeEach(() => {
			config = createPosseModeConfig('auto');
			mockRegistry = createMockRegistry();
			router = createTaskRouter(config, mockRegistry);
		});

		it('should return current strategy', () => {
			expect(router.getStrategy()).toBe('auto');
		});

		it('should return healthy agents', () => {
			mockRegistry.addAgent(createMockAgent('agent-1'));

			const agents = router.getHealthyAgents();
			expect(agents).toHaveLength(1);
		});
	});

	describe('factory functions', () => {
		it('createTaskRouter should create a TaskRouter', () => {
			const config = createSingleModeConfig();
			const router = createTaskRouter(config);
			expect(router).toBeInstanceOf(TaskRouter);
		});

		it('createHttpAgentClient should create an HttpAgentClient', () => {
			const client = createHttpAgentClient();
			expect(client).toBeInstanceOf(HttpAgentClient);
		});
	});

	describe('custom errors', () => {
		it('RoutingError should have correct properties', () => {
			const error = new RoutingError('Test error', 'TEST_ERROR', 500);
			expect(error.message).toBe('Test error');
			expect(error.code).toBe('TEST_ERROR');
			expect(error.statusCode).toBe(500);
		});

		it('NoHealthyAgentsError should have correct defaults', () => {
			const error = new NoHealthyAgentsError();
			expect(error.message).toBe('No healthy agents available');
			expect(error.code).toBe('NO_HEALTHY_AGENTS');
			expect(error.statusCode).toBe(503);
		});

		it('AgentNotFoundError should include agent name', () => {
			const error = new AgentNotFoundError('missing-agent');
			expect(error.message).toBe('Agent not found: missing-agent');
			expect(error.code).toBe('AGENT_NOT_FOUND');
			expect(error.statusCode).toBe(404);
		});
	});
});
