import { createLogger } from "@randal/core";

export interface EmbeddingServiceOptions {
	apiKey: string;
	model?: string;
	url?: string;
	timeoutMs?: number;
	dimensions?: number;
}

const DEFAULT_MODEL = "openai/text-embedding-3-small";
const DEFAULT_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_DIMENSIONS = 1536;

export class EmbeddingService {
	private apiKey: string;
	private model: string;
	private url: string;
	private timeoutMs: number;
	readonly dimensions: number;
	private logger = createLogger({ context: { component: "embedding-service" } });

	constructor(options: EmbeddingServiceOptions) {
		this.apiKey = options.apiKey;
		this.model = options.model ?? DEFAULT_MODEL;
		this.url = options.url ?? DEFAULT_URL;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
	}

	/**
	 * Generate an embedding vector for a single text.
	 * Returns null on ANY failure — never throws.
	 */
	async embed(text: string): Promise<number[] | null> {
		if (!this.apiKey) {
			return null;
		}

		try {
			const response = await fetch(this.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: this.model,
					input: text,
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
			});

			if (!response.ok) {
				this.logger.warn("Embedding API returned non-OK status", {
					status: response.status,
					statusText: response.statusText,
					model: this.model,
				});
				return null;
			}

			const json = await response.json();

			// Validate response shape: { data: [{ embedding: number[] }] }
			const embedding = json?.data?.[0]?.embedding;
			if (!Array.isArray(embedding) || embedding.length === 0) {
				this.logger.warn("Embedding API returned malformed data", {
					model: this.model,
					dataKeys: json?.data ? Object.keys(json.data[0] ?? {}) : "no data",
				});
				return null;
			}

			// Validate that all elements are numbers
			if (!embedding.every((v: unknown) => typeof v === "number")) {
				this.logger.warn("Embedding API returned non-numeric values", {
					model: this.model,
				});
				return null;
			}

			// Warn if dimension mismatch (still return the vector — Meilisearch will reject if wrong)
			if (embedding.length !== this.dimensions) {
				this.logger.warn("Embedding dimension mismatch", {
					expected: this.dimensions,
					actual: embedding.length,
					model: this.model,
				});
			}

			return embedding;
		} catch (err) {
			// Covers: network errors, timeouts (AbortError), JSON parse errors, etc.
			this.logger.warn("Embedding generation failed", {
				error: err instanceof Error ? err.message : String(err),
				model: this.model,
			});
			return null;
		}
	}

	/**
	 * Generate embeddings for multiple texts in a single API call.
	 * Returns an array of results — null for any text that failed.
	 * The OpenRouter API supports batch input natively.
	 */
	async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
		if (!this.apiKey || texts.length === 0) {
			return texts.map(() => null);
		}

		try {
			const response = await fetch(this.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: this.model,
					input: texts,
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
			});

			if (!response.ok) {
				this.logger.warn("Batch embedding API returned non-OK status", {
					status: response.status,
					statusText: response.statusText,
					model: this.model,
					batchSize: texts.length,
				});
				return texts.map(() => null);
			}

			const json = await response.json();

			if (!Array.isArray(json?.data)) {
				this.logger.warn("Batch embedding API returned malformed data", {
					model: this.model,
				});
				return texts.map(() => null);
			}

			// Map results by index — the API returns data sorted by index field
			const results: (number[] | null)[] = texts.map(() => null);

			for (const item of json.data) {
				const idx = item?.index;
				const embedding = item?.embedding;

				if (typeof idx !== "number" || idx < 0 || idx >= texts.length) {
					continue;
				}

				if (!Array.isArray(embedding) || embedding.length === 0) {
					continue;
				}

				if (!embedding.every((v: unknown) => typeof v === "number")) {
					continue;
				}

				if (embedding.length !== this.dimensions) {
					this.logger.warn("Batch embedding dimension mismatch", {
						expected: this.dimensions,
						actual: embedding.length,
						index: idx,
						model: this.model,
					});
				}

				results[idx] = embedding;
			}

			return results;
		} catch (err) {
			this.logger.warn("Batch embedding generation failed", {
				error: err instanceof Error ? err.message : String(err),
				model: this.model,
				batchSize: texts.length,
			});
			return texts.map(() => null);
		}
	}
}
