/**
 * HTTP client for the gateway API.
 * Used by the dashboard JavaScript for all API calls.
 * In v0.1, this is implemented inline in index.html's script tag.
 */

export interface ApiClient {
	getJobs(): Promise<unknown[]>;
	getJob(id: string): Promise<unknown>;
	createJob(prompt: string): Promise<{ id: string; status: string }>;
	stopJob(id: string): Promise<void>;
	injectContext(id: string, text: string): Promise<void>;
	searchMemory(query: string): Promise<unknown[]>;
	getConfig(): Promise<unknown>;
	getInstance(): Promise<unknown>;
}
