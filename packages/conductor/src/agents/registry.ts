/**
 * Agent Registry for Posse Conductor
 *
 * Manages agent discovery and health tracking via Meilisearch.
 * Polls the posse-registry index for agent heartbeats and calculates
 * health status based on time since last heartbeat.
 */

import type { Index, MeiliSearch } from 'meilisearch';
import type {
	AgentRecord,
	AgentStats,
	RegistryEvent,
	RegistryEventType,
} from '../types.ts';

// ============================================================================
// Types
// ============================================================================

/**
 * Extended agent status with computed health state
 */
export type ComputedAgentStatus = 'healthy' | 'busy' | 'stale' | 'offline';

/**
 * Agent health information with computed status
 */
export interface AgentHealth {
	/** Computed status based on heartbeat age */
	status: ComputedAgentStatus;
	/** Last seen timestamp (ISO 8601) */
	lastSeen: string;
	/** Whether agent is responsive (healthy or busy) */
	isResponsive: boolean;
	/** Time since last heartbeat in ms */
	msSinceLastHeartbeat: number;
}

/**
 * Enriched agent record with computed health
 */
export interface EnrichedAgentRecord extends AgentRecord {
	/** Computed health information */
	health: AgentHealth;
}

/**
 * Registry event emitter interface
 */
export interface RegistryEventEmitter {
	on(event: RegistryEventType, listener: (event: RegistryEvent) => void): void;
	off(event: RegistryEventType, listener: (event: RegistryEvent) => void): void;
	emit(event: RegistryEventType, payload: RegistryEvent): void;
}

/**
 * Agent registry configuration
 */
export interface RegistryConfig {
	/** Meilisearch client instance */
	client: MeiliSearch;
	/** Posse name for index selection */
	posseName: string;
	/** Poll interval in ms (default: 30000) */
	pollInterval?: number;
	/** Stale threshold in ms (default: 600000 = 10min) */
	staleThreshold?: number;
}

// ============================================================================
// Simple Event Emitter Implementation
// ============================================================================

class SimpleEventEmitter implements RegistryEventEmitter {
	private listeners: Map<RegistryEventType, Array<(event: RegistryEvent) => void>> =
		new Map();

	on(event: RegistryEventType, listener: (event: RegistryEvent) => void): void {
		const existing = this.listeners.get(event) || [];
		existing.push(listener);
		this.listeners.set(event, existing);
	}

	off(event: RegistryEventType, listener: (event: RegistryEvent) => void): void {
		const existing = this.listeners.get(event) || [];
		const filtered = existing.filter((l) => l !== listener);
		this.listeners.set(event, filtered);
	}

	emit(event: RegistryEventType, payload: RegistryEvent): void {
		const listeners = this.listeners.get(event) || [];
		for (const listener of listeners) {
			try {
				listener(payload);
			} catch (err) {
				console.error(`Error in registry event listener for ${event}:`, err);
			}
		}
	}
}

// ============================================================================
// Agent Registry Class
// ============================================================================

export class AgentRegistry {
	private client: MeiliSearch;
	private posseName: string;
	private indexName: string;
	private index: Index | null = null;
	private pollInterval: number;
	private staleThreshold: number;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private eventEmitter = new SimpleEventEmitter();
	private agents: Map<string, EnrichedAgentRecord> = new Map();

	private isPolling = false;
	private lastPollTime: Date | null = null;

	/**
	 * Create a new AgentRegistry
	 */
	constructor(config: RegistryConfig) {
		this.client = config.client;
		this.posseName = config.posseName;
		this.indexName = `posse-registry-${config.posseName}`;
		this.pollInterval = config.pollInterval ?? 30000;
		this.staleThreshold = config.staleThreshold ?? 600000; // 10 minutes
	}

	/**
	 * Initialize the registry and ensure index exists
	 */
	async initialize(): Promise<void> {
		try {
			// Get or create the index
			const indexes = await this.client.getIndexes();
			const exists = indexes.results.some((idx) => idx.uid === this.indexName);

			if (!exists) {
				await this.client.createIndex(this.indexName, { primaryKey: 'id' });
			}

			this.index = this.client.index(this.indexName);

			// Perform initial refresh
			await this.refresh();
		} catch (err) {
			console.error('Failed to initialize agent registry:', err);
			throw new Error(
				`Failed to initialize registry index ${this.indexName}: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}
	}

	/**
	 * Start periodic polling of the registry
	 */
	startPolling(): void {
		if (this.isPolling) {
			console.warn('Registry polling already started');
			return;
		}

		this.isPolling = true;

		// Immediate first refresh
		this.refresh().catch((err) => {
			console.error('Initial registry refresh failed:', err);
		});

		// Set up periodic polling
		this.pollTimer = setInterval(() => {
			this.refresh().catch((err) => {
				console.error('Registry refresh failed:', err);
			});
		}, this.pollInterval);

		console.log(
			`Started agent registry polling for posse "${this.posseName}" every ${
				this.pollInterval
			}ms`
		);
	}

	/**
	 * Stop periodic polling
	 */
	stopPolling(): void {
		if (!this.isPolling) {
			return;
		}

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		this.isPolling = false;
		console.log(`Stopped agent registry polling for posse "${this.posseName}"`);
	}

	/**
	 * Force immediate refresh from Meilisearch
	 */
	async refresh(): Promise<void> {
		if (!this.index) {
			throw new Error('Registry not initialized. Call initialize() first.');
		}

		try {
			// Search for all agents in the index
			const result = await this.index.search('', {
				limit: 1000,
			});

			const newAgents = new Map<string, EnrichedAgentRecord>();
			const now = new Date();

			for (const hit of result.hits) {
				const record = hit as unknown as AgentRecord;
				const enriched = this.enrichAgentRecord(record);
				newAgents.set(record.name, enriched);

				// Check for status changes
				const existing = this.agents.get(record.name);
				if (existing) {
					const prevHealth = existing.health.status;
					const newHealth = enriched.health.status;

					if (prevHealth !== newHealth) {
						this.emitStatusChange(existing, enriched, prevHealth, newHealth);
					}
				} else {
					// New agent discovered
					this.eventEmitter.emit('agent:online', {
						type: 'agent:online',
						agent: record,
						timestamp: now.toISOString(),
					});
				}
			}

			// Check for agents that went offline
			for (const [name, existing] of this.agents) {
				if (!newAgents.has(name)) {
					this.eventEmitter.emit('agent:offline', {
						type: 'agent:offline',
						agent: existing,
						timestamp: now.toISOString(),
					});
				}
			}

			this.agents = newAgents;
			this.lastPollTime = now;
		} catch (err) {
			console.error('Failed to refresh agent registry:', err);
			throw err;
		}
	}

	/**
	 * Get a single agent by name
	 */
	getAgent(name: string): EnrichedAgentRecord | undefined {
		return this.agents.get(name);
	}

	/**
	 * Get all registered agents
	 */
	getAllAgents(): EnrichedAgentRecord[] {
		return Array.from(this.agents.values());
	}

	/**
	 * Get only healthy agents (healthy or busy status)
	 */
	getHealthyAgents(): EnrichedAgentRecord[] {
		return this.getAllAgents().filter(
			(agent) => agent.health.status === 'healthy' || agent.health.status === 'busy'
		);
	}

	/**
	 * Get agents filtered by role
	 */
	getAgentsByRole(role: string): EnrichedAgentRecord[] {
		return this.getAllAgents().filter(
			(agent) => agent.metadata?.role === role || agent.capabilities.includes(role)
		);
	}

	/**
	 * Get agents filtered by capability
	 */
	getAgentsByCapability(capability: string): EnrichedAgentRecord[] {
		return this.getAllAgents().filter((agent) =>
			agent.capabilities.includes(capability)
		);
	}

	/**
	 * Get agents that support a specific model
	 */
	getAgentsByModel(model: string): EnrichedAgentRecord[] {
		return this.getAllAgents().filter((agent) => agent.models.includes(model));
	}

	/**
	 * Get agent statistics
	 */
	getStats(): AgentStats {
		const all = this.getAllAgents();
		return {
			total: all.length,
			online: all.filter((a) => a.health.status === 'healthy').length,
			offline: all.filter((a) => a.health.status === 'offline').length,
			busy: all.filter((a) => a.health.status === 'busy').length,
			error: all.filter((a) => a.health.status === 'stale').length,
		};
	}

	/**
	 * Subscribe to registry events
	 */
	on(event: RegistryEventType, listener: (event: RegistryEvent) => void): void {
		this.eventEmitter.on(event, listener);
	}

	/**
	 * Unsubscribe from registry events
	 */
	off(event: RegistryEventType, listener: (event: RegistryEvent) => void): void {
		this.eventEmitter.off(event, listener);
	}

	/**
	 * Check if polling is active
	 */
	get isActive(): boolean {
		return this.isPolling;
	}

	/**
	 * Get last poll timestamp
	 */
	get lastPoll(): Date | null {
		return this.lastPollTime;
	}

	/**
	 * Get the posse name
	 */
	getPosseName(): string {
		return this.posseName;
	}

	// ============================================================================
	// Private Methods
	// ============================================================================

	/**
	 * Enrich an agent record with computed health information
	 */
	private enrichAgentRecord(record: AgentRecord): EnrichedAgentRecord {
		const lastSeen = new Date(record.lastSeen);
		const now = new Date();
		const msSinceLastHeartbeat = now.getTime() - lastSeen.getTime();

		let status: ComputedAgentStatus;
		if (msSinceLastHeartbeat > this.staleThreshold) {
			status = 'stale';
		} else if (record.status === 'busy') {
			status = 'busy';
		} else if (record.status === 'offline') {
			status = 'offline';
		} else {
			status = 'healthy';
		}

		const health: AgentHealth = {
			status,
			lastSeen: record.lastSeen,
			isResponsive: status === 'healthy' || status === 'busy',
			msSinceLastHeartbeat,
		};

		return {
			...record,
			health,
		};
	}

	/**
	 * Emit status change events
	 */
	private emitStatusChange(
		oldAgent: EnrichedAgentRecord,
		newAgent: EnrichedAgentRecord,
		prevStatus: ComputedAgentStatus,
		newStatus: ComputedAgentStatus
	): void {
		const timestamp = new Date().toISOString();

		if (newStatus === 'healthy' && prevStatus !== 'healthy') {
			this.eventEmitter.emit('agent:online', {
				type: 'agent:online',
				agent: newAgent,
				previousStatus: oldAgent.status,
				timestamp,
			});
		} else if (newStatus === 'offline' && prevStatus !== 'offline') {
			this.eventEmitter.emit('agent:offline', {
				type: 'agent:offline',
				agent: newAgent,
				previousStatus: oldAgent.status,
				timestamp,
			});
		} else if (newStatus === 'busy') {
			this.eventEmitter.emit('agent:busy', {
				type: 'agent:busy',
				agent: newAgent,
				previousStatus: oldAgent.status,
				timestamp,
			});
		} else if (newStatus === 'healthy' && prevStatus === 'busy') {
			this.eventEmitter.emit('agent:idle', {
				type: 'agent:idle',
				agent: newAgent,
				previousStatus: oldAgent.status,
				timestamp,
			});
		}

		// Always emit updated event
		this.eventEmitter.emit('agent:updated', {
			type: 'agent:updated',
			agent: newAgent,
			previousStatus: oldAgent.status,
			timestamp,
		});
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new agent registry instance
 */
export function createAgentRegistry(config: RegistryConfig): AgentRegistry {
	return new AgentRegistry(config);
}

/**
 * Create and initialize an agent registry
 */
export async function createAndInitializeRegistry(
	config: RegistryConfig
): Promise<AgentRegistry> {
	const registry = new AgentRegistry(config);
	await registry.initialize();
	return registry;
}
