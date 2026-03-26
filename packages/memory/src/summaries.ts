import type { MessageDoc } from "@randal/core";
import { createLogger } from "@randal/core";

export interface SummaryGeneratorOptions {
	/** OpenRouter API key */
	apiKey: string;
	/** Model to use for summarization (default: anthropic/claude-haiku-3) */
	model?: string;
	/** OpenRouter base URL (default: https://openrouter.ai/api/v1) */
	baseUrl?: string;
	/** Request timeout in milliseconds (default: 30000) */
	timeoutMs?: number;
}

export interface GeneratedSummary {
	summary: string;
	topicKeywords: string[];
}

const DEFAULT_MODEL = "anthropic/claude-haiku-3";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `You are a conversation summarizer. Given a conversation, produce a JSON response with exactly two fields:
- "summary": A 2-3 sentence summary covering topics discussed, decisions made, and action items.
- "topicKeywords": An array of 3-7 keywords/phrases for search matching.

Respond ONLY with valid JSON. No markdown fences, no explanation.`;

/**
 * Generates concise summaries from conversation message windows using an LLM.
 * This class has ONE job: take messages, return a summary.
 */
export class ChatSummaryGenerator {
	private apiKey: string;
	private model: string;
	private baseUrl: string;
	private timeoutMs: number;
	private logger = createLogger({ context: { component: "chat-summary" } });

	constructor(options: SummaryGeneratorOptions) {
		if (!options.apiKey) {
			throw new Error("ChatSummaryGenerator requires an apiKey");
		}
		this.apiKey = options.apiKey;
		this.model = options.model ?? DEFAULT_MODEL;
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/**
	 * Generate a summary from a window of conversation messages.
	 * @param messages - Array of MessageDoc to summarize (should be chronologically ordered)
	 * @returns Generated summary with topic keywords
	 * @throws Error on API failure, timeout, or invalid response
	 */
	async generate(messages: MessageDoc[]): Promise<GeneratedSummary> {
		if (messages.length === 0) {
			throw new Error("Cannot generate summary from empty message array");
		}

		const formattedConversation = this.formatMessages(messages);
		const responseText = await this.callLLM(formattedConversation);
		return this.parseResponse(responseText);
	}

	/** Format messages into a readable conversation string for the LLM. */
	private formatMessages(messages: MessageDoc[]): string {
		return messages
			.map((msg) => {
				const timestamp = msg.timestamp;
				const speaker = msg.speaker;
				return `[${timestamp}] ${speaker}: ${msg.content}`;
			})
			.join("\n");
	}

	/** Call OpenRouter chat completion API. */
	private async callLLM(conversation: string): Promise<string> {
		const url = `${this.baseUrl}/chat/completions`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: this.model,
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						{
							role: "user",
							content: `Summarize this conversation:\n\n${conversation}`,
						},
					],
					temperature: 0.3,
					max_tokens: 500,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorBody = await response.text().catch(() => "unknown");
				throw new Error(
					`OpenRouter API error: ${response.status} ${response.statusText} — ${errorBody}`,
				);
			}

			const data = (await response.json()) as OpenRouterChatResponse;

			const content = data?.choices?.[0]?.message?.content;
			if (typeof content !== "string" || content.length === 0) {
				throw new Error(
					`OpenRouter returned empty or invalid content: ${JSON.stringify(data)}`,
				);
			}

			return content;
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				throw new Error(
					`OpenRouter API request timed out after ${this.timeoutMs}ms`,
				);
			}
			throw err;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/** Parse the LLM's JSON response into a GeneratedSummary. */
	private parseResponse(raw: string): GeneratedSummary {
		// Strip markdown code fences if the model wraps them
		const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

		let parsed: unknown;
		try {
			parsed = JSON.parse(cleaned);
		} catch {
			this.logger.error("Failed to parse LLM summary response as JSON", {
				raw,
			});
			throw new Error(`Invalid JSON in summary response: ${cleaned.slice(0, 200)}`);
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("summary" in parsed) ||
			!("topicKeywords" in parsed)
		) {
			throw new Error(
				`Summary response missing required fields (summary, topicKeywords): ${JSON.stringify(parsed).slice(0, 200)}`,
			);
		}

		const obj = parsed as Record<string, unknown>;

		if (typeof obj.summary !== "string" || obj.summary.length === 0) {
			throw new Error("Summary response has empty or non-string 'summary' field");
		}

		if (!Array.isArray(obj.topicKeywords)) {
			throw new Error("Summary response has non-array 'topicKeywords' field");
		}

		const topicKeywords = obj.topicKeywords.filter(
			(kw): kw is string => typeof kw === "string" && kw.length > 0,
		);

		if (topicKeywords.length === 0) {
			this.logger.warn("Summary response had no valid topic keywords, using fallback");
		}

		return {
			summary: obj.summary,
			topicKeywords,
		};
	}
}

/** Minimal type for the OpenRouter chat completion response shape we care about. */
interface OpenRouterChatResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
}
