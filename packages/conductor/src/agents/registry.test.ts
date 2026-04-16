/**
 * Tests for Agent Registry
 *
 * @module agents/registry.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { AgentRegistry, createAgentRegistry, createAndInitializeRegistry } from './registry.ts';
import type { AgentRecord } from '../types.ts';

// ============================================================================
// Mock Meilisearch
// ============================================================================

class MockMeiliSearch {
	indexes: Map<string, MockIndex> = new Map();

	async getIndexes() {
		return {
			results: Array.from(this.indexes.entries()).map(([uid]) => ({ uid })),
		};
	}

	async createIndex(uid: string, _options?: { primaryKey?: string }) {
		const index = new MockIndex();
		this.indexes.set(uid, index);
		return index;
	}

	index(uid: string): MockIndex {
		if (!this.indexes.has(uid)) {
			this.indexes.set(uid, new MockIndex());
		}
		const idx = this.indexes.get(uid);
		if (!idx) throw new Error(`Index ${uid} not found`);
		return idx;
	}
}

class MockIndex {
	documents: Map<string, AgentRecord> = new Map();

	async addDocuments(docs: AgentRecord[]) {
		for (const doc of docs) {
			this.documents.set(doc.id, doc);
		}
		return { taskUid: 1 };
	}

	async search(_query: string, _options?: { limit?: number }) {
		return {
			hits: Array.from(this.documents.values()),
			estimatedTotalHits: this.documents.size,
		};
	}

	addMockAgent(agent: AgentRecord) {
		this.documents.set(agent.id, agent);
	}

	clear() {
		this.documents.clear();
	}
}

// ============================================================================
// Test Helpers
// ============================================================================

function createMockAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	const now = new Date().toISOString();
	return {
		id: `agent-${Math.random().toString(36).slice(2)}`,
		name: `test-agent-${Math.random().toString(36).slice(2, 7)}`,
		endpoint: 'http://localhost:7600',
		models: ['moonshotai/kimi-k2.5'],
		capabilities: ['chat', 'code'],
		status: 'online',
		lastSeen: now,
		version: '0.1.0',
		metadata: { role: 'product-engineering' },
		...overrides,
	};
}

// ============================================================================
// Test Suite
// ============================================================================

describe('AgentRegistry', () => {
	let mockClient: MockMeiliSearch;
	let registry: AgentRegistry;
	let index: MockIndex;

	beforeEach(async () => {
		mockClient = new MockMeiliSearch();
		registry = createAgentRegistry({
			client: mockClient as unknown as import('meilisearch').MeiliSearch,
			posseName: 'test-posse',
			pollInterval: 1000,
			staleThreshold: 10000,
		});

		await registry.initialize();
		index = mockClient.indexes.get('posse-registry-test-posse');
		if (!index) throw new Error('Index not created');
	});

	afterEach(() => {
		registry.stopPolling();
	});

	describe('initialization', () => {
		it('should create the registry index if it does not exist', async () => {
			const newClient = new MockMeiliSearch();
			const newRegistry = createAgentRegistry({
				client: newClient as unknown as import('meilisearch').MeiliSearch,
				posseName: 'new-posse',
			});

			await newRegistry.initialize();
			expect(newClient.indexes.has('posse-registry-new-posse')).toBe(true);
		});

		it('should use existing index if it exists', async () => {
			// Index already created in beforeEach
			expect(mockClient.indexes.has('posse-registry-test-posse')).toBe(true);
		});
	});

	describe('polling', () => {
		it('should start and stop polling', () => {
			expect(registry.isActive).toBe(false);
			registry.startPolling();
			expect(registry.isActive).toBe(true);
			registry.stopPolling();
			expect(registry.isActive).toBe(false);
		});

		it('should warn when starting polling twice', () => {
			const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
			registry.startPolling();
			registry.startPolling();
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	describe('agent retrieval', () => {
		it('should get agent by name', async () => {
			const agent = createMockAgent({ name: 'test-agent' });
			index.addMockAgent(agent);
			await registry.refresh();

			const result = registry.getAgent('test-agent');
			expect(result).toBeDefined();
			expect(result?.name).toBe('test-agent');
		});

		it('should return undefined for non-existent agent', () => {
			const result = registry.getAgent('non-existent');
			expect(result).toBeUndefined();
		});

		it('should get all agents', async () => {
			index.addMockAgent(createMockAgent({ name: 'agent-1' }));
			index.addMockAgent(createMockAgent({ name: 'agent-2' }));
			await registry.refresh();

			const agents = registry.getAllAgents();
			expect(agents).toHaveLength(2);
		});

		it('should filter agents by role', async () => {
			index.addMockAgent(createMockAgent({
				name: 'agent-1',
				metadata: { role: 'product-engineering' }
			}));
			index.addMockAgent(createMockAgent({
				name: 'agent-2',
				metadata: { role: 'security' }
			}));
			await registry.refresh();

			const productAgents = registry.getAgentsByRole('product-engineering');
			expect(productAgents).toHaveLength(1);
			expect(productAgents[0].name).toBe('agent-1');
		});

		it('should filter agents by capability', async () => {
			index.addMockAgent(createMockAgent({
				name: 'agent-1',
				capabilities: ['chat', 'code']
			}));
			index.addMockAgent(createMockAgent({
				name: 'agent-2',
				capabilities: ['chat']
			}));
			await registry.refresh();

			const codeAgents = registry.getAgentsByCapability('code');
			expect(codeAgents).toHaveLength(1);
			expect(codeAgents[0].name).toBe('agent-1');
		});

		it('should filter agents by model', async () => {
			index.addMockAgent(createMockAgent({
				name: 'agent-1',
				models: ['model-a']
			}));
			index.addMockAgent(createMockAgent({
				name: 'agent-2',
				models: ['model-b']
			}));
			await registry.refresh();

			const modelAAgents = registry.getAgentsByModel('model-a');
			expect(modelAAgents).toHaveLength(1);
			expect(modelAAgents[0].name).toBe('agent-1');
		});
	});

	describe('health calculation', () => {
		it('should mark recent agents as healthy', async () => {
			const agent = createMockAgent({
				lastSeen: new Date().toISOString(),
				status: 'online'
			});
			index.addMockAgent(agent);
			await registry.refresh();

			const result = registry.getAgent(agent.name);
			expect(result?.health.status).toBe('healthy');
			expect(result?.health.isResponsive).toBe(true);
		});

		it('should mark busy agents correctly', async () => {
			const agent = createMockAgent({
				lastSeen: new Date().toISOString(),
				status: 'busy'
			});
			index.addMockAgent(agent);
			await registry.refresh();

			const result = registry.getAgent(agent.name);
			expect(result?.health.status).toBe('busy');
			expect(result?.health.isResponsive).toBe(true);
		});

		it('should mark stale agents correctly', async () => {
			const oldDate = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
			const agent = createMockAgent({
				lastSeen: oldDate,
				status: 'online'
			});
			index.addMockAgent(agent);
			await registry.refresh();

			const result = registry.getAgent(agent.name);
			expect(result?.health.status).toBe('stale');
			expect(result?.health.isResponsive).toBe(false);
		});

		it('should filter healthy agents', async () => {
			index.addMockAgent(createMockAgent({
				name: 'healthy-agent',
				lastSeen: new Date().toISOString(),
				status: 'online'
			}));
			index.addMockAgent(createMockAgent({
				name: 'busy-agent',
				lastSeen: new Date().toISOString(),
				status: 'busy'
			}));
			index.addMockAgent(createMockAgent({
				name: 'stale-agent',
				lastSeen: new Date(Date.now() - 60000).toISOString(),
				status: 'online'
			}));
			await registry.refresh();

			const healthyAgents = registry.getHealthyAgents();
			expect(healthyAgents).toHaveLength(2);
			expect(healthyAgents.map(a => a.name).sort()).toEqual(['busy-agent', 'healthy-agent']);
		});
	});

	describe('statistics', () => {
		it('should return correct statistics', async () => {
			const now = new Date().toISOString();
			const oldDate = new Date(Date.now() - 60000).toISOString();

			index.addMockAgent(createMockAgent({ lastSeen: now, status: 'online' }));
			index.addMockAgent(createMockAgent({ lastSeen: now, status: 'busy' }));
			index.addMockAgent(createMockAgent({ lastSeen: oldDate, status: 'online' }));
			index.addMockAgent(createMockAgent({ lastSeen: oldDate, status: 'offline' }));
			await registry.refresh();

			const stats = registry.getStats();
			expect(stats.total).toBe(4);
			expect(stats.online).toBe(1);
			expect(stats.busy).toBe(1);
			expect(stats.error).toBe(2); // stale + offline both count as error
			expect(stats.offline).toBe(0);
		});
	});

	describe('events', () => {
		it('should emit agent:online event for new agents', async () => {
			const events: string[] = [];
			registry.on('agent:online', () => events.push('online'));

			index.addMockAgent(createMockAgent({ name: 'new-agent' }));
			await registry.refresh();

			expect(events).toContain('online');
		});

		it('should emit agent:offline event when agents disappear', async () => {
			const agent = createMockAgent({ name: 'disappearing-agent' });
			index.addMockAgent(agent);
			await registry.refresh();

			const events: string[] = [];
			registry.on('agent:offline', () => events.push('offline'));

			index.clear();
			await registry.refresh();

			expect(events).toContain('offline');
		});

		it('should emit agent:busy event when agent becomes busy', async () => {
			const agent = createMockAgent({
				name: 'agent',
				status: 'online',
				lastSeen: new Date().toISOString()
			});
			index.addMockAgent(agent);
			await registry.refresh();

			const events: string[] = [];
			registry.on('agent:busy', () => events.push('busy'));

			agent.status = 'busy';
			await registry.refresh();

			expect(events).toContain('busy');
		});
	});

	describe('factory functions', () => {
		it('createAgentRegistry should create a registry', () => {
			const r = createAgentRegistry({
				client: mockClient as unknown as import('meilisearch').MeiliSearch,
				posseName: 'factory-test',
			});
			expect(r).toBeInstanceOf(AgentRegistry);
			expect(r.getPosseName()).toBe('factory-test');
		});

		it('createAndInitializeRegistry should create and initialize', async () => {
			const r = await createAndInitializeRegistry({
				client: mockClient as unknown as import('meilisearch').MeiliSearch,
				posseName: 'init-test',
			});
			expect(r).toBeInstanceOf(AgentRegistry);
			expect(mockClient.indexes.has('posse-registry-init-test')).toBe(true);
		});
	});
});
