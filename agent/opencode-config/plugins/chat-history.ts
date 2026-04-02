/**
 * Chat history plugin for OpenCode.
 *
 * Writes conversation messages directly to Meilisearch via fetch.
 * Generates embeddings inline (via OpenRouter) when OPENROUTER_API_KEY is set,
 * and attaches them as `_vectors: { default: { value: [...] } }` on the document.
 *
 * If embedding fails or no API key is configured, documents are stored
 * without vectors — keyword search still works.
 *
 * This plugin is self-contained: it does NOT import from @randal/memory
 * because it runs inside the OpenCode plugin runtime.
 *
 * Environment variables (read from process.env):
 *   MEILI_URL          — Meilisearch URL (default: http://localhost:7700)
 *   MEILI_MASTER_KEY   — Meilisearch API key (optional)
 *   OPENROUTER_API_KEY — enables embedding generation (optional)
 *   EMBEDDING_MODEL    — embedding model (default: openai/text-embedding-3-small)
 *   EMBEDDING_URL      — embedding endpoint (default: https://openrouter.ai/api/v1/embeddings)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7700";
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || "";
const MEILI_INDEX = process.env.MEILI_CHAT_INDEX || "messages-randal";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
const EMBEDDING_URL = process.env.EMBEDDING_URL || "https://openrouter.ai/api/v1/embeddings";

const EMBEDDING_TIMEOUT_MS = 5000;
const EMBEDDER_NAME = "default";

// ---------------------------------------------------------------------------
// Inline embedding function (self-contained, never throws)
// ---------------------------------------------------------------------------

/**
 * Generate an embedding vector for the given text via OpenRouter-compatible API.
 * Returns null on ANY failure — never throws.
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
	if (!OPENROUTER_API_KEY) {
		return null;
	}

	try {
		const response = await fetch(EMBEDDING_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			},
			body: JSON.stringify({
				model: EMBEDDING_MODEL,
				input: text,
			}),
			signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
		});

		if (!response.ok) {
			console.error(
				`[chat-history] Embedding API error: ${response.status} ${response.statusText} (model: ${EMBEDDING_MODEL})`,
			);
			return null;
		}

		const json = await response.json();
		const embedding = json?.data?.[0]?.embedding;

		if (!Array.isArray(embedding) || embedding.length === 0) {
			console.error(
				`[chat-history] Embedding API returned malformed data (model: ${EMBEDDING_MODEL})`,
			);
			return null;
		}

		return embedding as number[];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[chat-history] Embedding generation failed: ${msg}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Meilisearch write (self-contained, fire-and-forget safe)
// ---------------------------------------------------------------------------

interface ChatMessage {
	id: string;
	threadId: string;
	speaker: string;
	channel: string;
	content: string;
	timestamp: string;
	type?: string;
	scope?: string;
	_vectors?: Record<string, { value: number[] }>;
}

/**
 * Write a chat message document to Meilisearch.
 * Generates an embedding if possible and attaches it as `_vectors`.
 * Never throws — logs errors to stderr.
 */
export async function writeChatMessage(message: Omit<ChatMessage, "_vectors">): Promise<void> {
	try {
		// Generate embedding for the message content (fire-and-forget safe)
		const embedding = await generateEmbedding(message.content);

		const doc: ChatMessage = {
			...message,
			...(embedding ? { _vectors: { [EMBEDDER_NAME]: { value: embedding } } } : {}),
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (MEILI_MASTER_KEY) {
			headers.Authorization = `Bearer ${MEILI_MASTER_KEY}`;
		}

		const response = await fetch(`${MEILI_URL}/indexes/${MEILI_INDEX}/documents`, {
			method: "POST",
			headers,
			body: JSON.stringify([doc]),
		});

		if (!response.ok) {
			console.error(
				`[chat-history] Meilisearch write failed: ${response.status} ${response.statusText}`,
			);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[chat-history] Failed to write chat message: ${msg}`);
	}
}
