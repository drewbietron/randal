/**
 * Store construction, initialization retry, and lazy re-init guards.
 *
 * Constructs EmbeddingService, MeilisearchStore, MessageManager, and
 * MeilisearchAnnotationStore from env-based config, then provides
 * retryInit() for background backoff and ensure*() guards for lazy init.
 */

import {
	MeilisearchAnnotationStore,
} from "@randal/analytics";
import type { RandalConfig } from "@randal/core";
import {
	EmbeddingService,
	MeilisearchStore,
	MessageManager,
} from "@randal/memory";
import type { SummaryGeneratorOptions } from "@randal/memory";
import { MeiliSearch } from "meilisearch";
import { log } from "../lib/mcp-transport.js";
import {
	ANALYTICS_ENABLED,
	EMBEDDING_MODEL,
	EMBEDDING_URL,
	INSTANCE_NAME,
	MEILI_INDEX,
	MEILI_MASTER_KEY,
	MEILI_URL,
	OPENROUTER_API_KEY,
	RANDAL_POSSE_NAME,
	RANDAL_SELF_NAME,
	SEMANTIC_RATIO,
	SUMMARY_MODEL,
	buildMcpServerConfig,
} from "./types.js";
export type { McpServerConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Store construction
// ---------------------------------------------------------------------------

export const embeddingService = OPENROUTER_API_KEY
	? new EmbeddingService({
			apiKey: OPENROUTER_API_KEY,
			model: EMBEDDING_MODEL,
			url: EMBEDDING_URL,
		})
	: undefined;

export const store = new MeilisearchStore({
	url: MEILI_URL,
	apiKey: MEILI_MASTER_KEY,
	index: MEILI_INDEX,
	embeddingService,
	semanticRatio: Number.isFinite(SEMANTIC_RATIO) ? SEMANTIC_RATIO : 0.7,
});

/** Whether the store initialized successfully. */
let storeAvailable = false;

/** Last init failure reason for diagnostics (null = no error). */
let storeInitError: string | null = null;

// ---------------------------------------------------------------------------
// MessageManager construction (chat history)
// ---------------------------------------------------------------------------

// Build the shared McpServerConfig once — used by MessageManager and posse stubs.
const mcpConfig = buildMcpServerConfig();

const summaryGeneratorConfig: SummaryGeneratorOptions | undefined = OPENROUTER_API_KEY
	? {
			apiKey: OPENROUTER_API_KEY,
			model: SUMMARY_MODEL,
		}
	: undefined;

// MessageManager expects a full RandalConfig but only reads config.memory.url,
// config.memory.apiKey, and config.name. Our McpServerConfig provides exactly
// those fields. The cast is safe because unused fields are never accessed.
export const messageManager = new MessageManager({
	config: mcpConfig as unknown as RandalConfig,
	embeddingService,
	semanticRatio: Number.isFinite(SEMANTIC_RATIO) ? SEMANTIC_RATIO : 0.7,
	summaryGenerator: summaryGeneratorConfig,
});

/** Whether the message manager initialized successfully. */
let messagesAvailable = false;

/** Last init failure reason for diagnostics (null = no error). */
let messagesInitError: string | null = null;

// ---------------------------------------------------------------------------
// Analytics store construction
// ---------------------------------------------------------------------------

const meiliClient = new MeiliSearch({ host: MEILI_URL, apiKey: MEILI_MASTER_KEY || undefined });
export const annotationStore = new MeilisearchAnnotationStore(meiliClient, INSTANCE_NAME);

/** Whether the annotation store initialized successfully. */
let analyticsAvailable = false;

/** Last init failure reason for diagnostics (null = no error). */
let analyticsInitError: string | null = null;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify an init error into a human-readable diagnostic message.
 * Extracts the root cause from common failure patterns without leaking secrets.
 */
export function classifyInitError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const lower = raw.toLowerCase();

	if (
		lower.includes("401") ||
		lower.includes("403") ||
		lower.includes("unauthorized") ||
		lower.includes("invalid api key") ||
		lower.includes("invalid_api_key")
	) {
		return `Authentication failed at ${MEILI_URL} — check MEILI_MASTER_KEY`;
	}
	if (
		lower.includes("econnrefused") ||
		lower.includes("fetch failed") ||
		lower.includes("has failed") ||
		lower.includes("connect")
	) {
		return `Connection refused at ${MEILI_URL} — is Meilisearch running?`;
	}
	if (lower.includes("timeout") || lower.includes("etimedout")) {
		return `Connection timed out at ${MEILI_URL}`;
	}
	return raw;
}

// ---------------------------------------------------------------------------
// Init retry with exponential backoff
// ---------------------------------------------------------------------------

/**
 * Retry store.init() and messageManager.init() with exponential backoff.
 * Each subsystem is retried independently so one failing doesn't block the other.
 * Never throws — sets availability flags on success, logs warnings on failure.
 * Stores the last error reason for diagnostic reporting in tool responses.
 */
export async function retryInit(): Promise<void> {
	const MAX_ATTEMPTS = 5;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			await store.init();
			storeAvailable = true;
			storeInitError = null;
			log("info", `Store initialized at ${MEILI_URL} (attempt ${attempt})`);
			break;
		} catch (err) {
			storeInitError = classifyInitError(err);
			const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
			log(
				"warn",
				`Store init attempt ${attempt}/${MAX_ATTEMPTS} failed: ${storeInitError}. Retry in ${delay}ms`,
			);
			if (attempt < MAX_ATTEMPTS) await Bun.sleep(delay);
		}
	}
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			await messageManager.init();
			messagesAvailable = true;
			messagesInitError = null;
			log("info", `MessageManager initialized (attempt ${attempt})`);
			break;
		} catch (err) {
			messagesInitError = classifyInitError(err);
			const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
			log(
				"warn",
				`MessageManager init attempt ${attempt}/${MAX_ATTEMPTS} failed: ${messagesInitError}. Retry in ${delay}ms`,
			);
			if (attempt < MAX_ATTEMPTS) await Bun.sleep(delay);
		}
	}
	if (ANALYTICS_ENABLED) {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				await annotationStore.init();
				analyticsAvailable = true;
				analyticsInitError = null;
				log("info", `AnnotationStore initialized (attempt ${attempt})`);
				break;
			} catch (err) {
				analyticsInitError = classifyInitError(err);
				const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
				log(
					"warn",
					`AnnotationStore init attempt ${attempt}/${MAX_ATTEMPTS} failed: ${analyticsInitError}. Retry in ${delay}ms`,
				);
				if (attempt < MAX_ATTEMPTS) await Bun.sleep(delay);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Lazy re-init guards
// ---------------------------------------------------------------------------

/** Lazy re-init: attempt store.init() if not yet available. Returns true if available. */
export async function ensureStore(): Promise<boolean> {
	if (storeAvailable) return true;
	try {
		await store.init();
		storeAvailable = true;
		storeInitError = null;
		log("info", "Store lazy re-init succeeded");
		return true;
	} catch (err) {
		storeInitError = classifyInitError(err);
		return false;
	}
}

/** Lazy re-init: attempt messageManager.init() if not yet available. Returns true if available. */
export async function ensureMessages(): Promise<boolean> {
	if (messagesAvailable) return true;
	try {
		await messageManager.init();
		messagesAvailable = true;
		messagesInitError = null;
		log("info", "MessageManager lazy re-init succeeded");
		return true;
	} catch (err) {
		messagesInitError = classifyInitError(err);
		return false;
	}
}

/** Lazy re-init: attempt annotationStore.init() if not yet available. Returns true if available. */
export async function ensureAnalytics(): Promise<boolean> {
	if (!ANALYTICS_ENABLED) return false;
	if (analyticsAvailable) return true;
	try {
		await annotationStore.init();
		analyticsAvailable = true;
		analyticsInitError = null;
		log("info", "AnnotationStore lazy re-init succeeded");
		return true;
	} catch (err) {
		analyticsInitError = classifyInitError(err);
		return false;
	}
}

/**
 * Check if posse is configured and the Meilisearch client is ready.
 * Returns true if posse_members/delegate_task/posse_memory_search tools can operate.
 */
export function ensurePosse(): boolean {
	return !!(RANDAL_POSSE_NAME && RANDAL_SELF_NAME);
}

// ---------------------------------------------------------------------------
// Config stubs for subsystem consumers
// ---------------------------------------------------------------------------

/**
 * Build a RandalConfig stub for posse operations (queryPosseMembers, searchCrossAgent).
 *
 * Uses McpServerConfig as the source of truth — all fields are populated from
 * centralized env var reads. The cast to RandalConfig is required because
 * @randal/memory functions expect the full type, but only read the fields
 * present in McpServerConfig (posse, name, memory.url/apiKey/sharing, mesh.endpoint).
 */
export function buildPosseConfigStub(): RandalConfig {
	// McpServerConfig already contains exactly the fields consumed by posse
	// operations. Cast through unknown because RandalConfig has many more
	// required fields (tools, runner, version, etc.) that are never accessed.
	return mcpConfig as unknown as RandalConfig;
}

// ---------------------------------------------------------------------------
// Diagnostic error getters
// ---------------------------------------------------------------------------

/** Get a diagnostic error string for store unavailability. */
export function getStoreError(): string {
	return storeInitError ?? "Meilisearch is not available (unknown reason)";
}

/** Get a diagnostic error string for messages unavailability. */
export function getMessagesError(): string {
	return messagesInitError ?? "Chat history is not available (unknown reason)";
}

/** Get a diagnostic error string for analytics unavailability. */
export function getAnalyticsError(): string {
	if (!ANALYTICS_ENABLED) return "Analytics not enabled (set ANALYTICS_ENABLED=true)";
	return analyticsInitError ?? "Annotation store is not available (unknown reason)";
}
