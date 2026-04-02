import type { Plugin } from "@opencode-ai/plugin";

// ---------------------------------------------------------------------------
// Configuration (from process.env, all optional)
// ---------------------------------------------------------------------------

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7701";
const MEILI_KEY = process.env.MEILI_MASTER_KEY || "";
const INDEX = "messages-randal";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
const EMBEDDING_URL = process.env.EMBEDDING_URL || "https://openrouter.ai/api/v1/embeddings";

// ---------------------------------------------------------------------------
// Inline embedding (never throws, returns null on failure)
// ---------------------------------------------------------------------------

async function generateEmbedding(text: string): Promise<number[] | null> {
	if (!OPENROUTER_API_KEY) return null;

	try {
		const response = await fetch(EMBEDDING_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			},
			body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) return null;

		const json = await response.json();
		const embedding = json?.data?.[0]?.embedding;
		if (!Array.isArray(embedding) || embedding.length === 0) return null;

		return embedding as number[];
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Meilisearch write (fire-and-forget, never throws)
// ---------------------------------------------------------------------------

async function logMessage(doc: {
	content: string;
	speaker: string;
	threadId: string;
	scope: string;
	channel: string;
}): Promise<void> {
	const id = crypto.randomUUID();
	try {
		const embedding = await generateEmbedding(doc.content);

		const body: Record<string, unknown> = {
			id,
			...doc,
			timestamp: new Date().toISOString(),
			type: "message",
		};

		if (embedding) {
			body._vectors = { default: { value: embedding } };
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (MEILI_KEY) {
			headers.Authorization = `Bearer ${MEILI_KEY}`;
		}

		await fetch(`${MEILI_URL}/indexes/${INDEX}/documents`, {
			method: "POST",
			headers,
			body: JSON.stringify([body]),
		});
	} catch (err) {
		console.error("[chat-history] Failed to log message:", err);
	}
}

// ---------------------------------------------------------------------------
// Plugin export (required by OpenCode)
// ---------------------------------------------------------------------------

export const server: Plugin = async ({ directory }) => {
	console.error("[chat-history] Plugin loaded");
	const scope = `project:${directory}`;

	// Track the last assistant messageID per session so we can flush on idle
	const pendingAssistant = new Map<string, string>();

	return {
		"chat.message": async (input, output) => {
			const textParts = output.parts.filter((p) => p.type === "text");
			const content = textParts.map((p) => (p as { type: "text"; text: string }).text).join("\n");
			if (!content.trim()) return;

			await logMessage({
				content,
				speaker: "user",
				threadId: input.sessionID,
				scope,
				channel: "opencode",
			});
		},

		event: async ({ event }) => {
			// Track assistant text parts as they stream in
			if (event.type === "message.part.updated") {
				const part = event.properties.part;
				if (part.type === "text" && part.text) {
					pendingAssistant.set(part.sessionID, part.messageID);
				}
			}

			// On session idle, capture the assistant's final text
			if (event.type === "session.idle") {
				const sessionID = event.properties.sessionID;
				const messageID = pendingAssistant.get(sessionID);
				if (!messageID) return;
				pendingAssistant.delete(sessionID);

				try {
					const result = await fetch(
						`http://127.0.0.1:19432/session/${sessionID}/message/${messageID}`,
					);
					if (!result.ok) return;

					const data = (await result.json()) as {
						parts: Array<{ type: string; text?: string }>;
					};

					const textContent = data.parts
						.filter((p: { type: string }) => p.type === "text")
						.map((p: { text?: string }) => p.text ?? "")
						.join("\n")
						.trim();

					if (!textContent) return;

					// Truncate very long responses
					const maxLen = 4000;
					const content =
						textContent.length > maxLen
							? `${textContent.slice(0, maxLen)}\n\n[truncated]`
							: textContent;

					await logMessage({
						content,
						speaker: "randal",
						threadId: sessionID,
						scope,
						channel: "opencode",
					});
				} catch {
					// Fire-and-forget
				}
			}
		},
	};
};
