/**
 * SSE subscription helper for real-time event streaming.
 * In v0.1, this is implemented inline in index.html's script tag
 * using the native EventSource API.
 */

export interface SSESubscription {
	close(): void;
}

export type SSEEventHandler = (event: { type: string; data: string }) => void;
