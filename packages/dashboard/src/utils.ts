/**
 * Dashboard utility functions.
 *
 * These functions are the canonical source of truth. They are duplicated
 * inline in index.html (since the dashboard has no build step). If you
 * modify a function here, update the corresponding inline version too.
 *
 * Tested in: src/__tests__/dashboard.test.ts
 */

/**
 * Escape HTML entities to prevent XSS when injecting into innerHTML.
 * Uses DOM-based escaping via createTextNode.
 */
export function escapeHtml(str: unknown): string {
	if (str == null) return "";
	const div = document.createElement("div");
	div.appendChild(document.createTextNode(String(str)));
	return div.innerHTML;
}

/**
 * Toast notification error deduplication timestamps.
 * Maps message string -> last shown timestamp.
 */
export const _toastErrorTimestamps: Record<string, number> = {};

/**
 * Show a toast notification.
 * @param message - Text to display
 * @param type - 'error' | 'success' | 'info' (default: 'info')
 * @param duration - Auto-dismiss delay in ms (default: 5000, 8000 for errors)
 */
export function showToast(message: string, type?: string, duration?: number): void {
	const _type = type || "info";
	const _duration = duration || (_type === "error" ? 8000 : 5000);

	// Deduplicate: suppress repeat error toasts for the same message within 30s
	if (_type === "error") {
		const now = Date.now();
		if (_toastErrorTimestamps[message] && now - _toastErrorTimestamps[message] < 30000) return;
		_toastErrorTimestamps[message] = now;
	}

	const container = document.getElementById("toast-container");
	if (!container) return;

	const toast = document.createElement("div");
	toast.className = `toast ${_type}`;
	toast.setAttribute("role", _type === "error" ? "alert" : "status");
	toast.innerHTML = `<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close" aria-label="Dismiss notification">&times;</button>`;

	const closeBtn = toast.querySelector(".toast-close") as HTMLButtonElement;

	function dismiss() {
		clearTimeout(timer);
		toast.classList.add("fade-out");
		toast.addEventListener("animationend", () => toast.remove());
		// Also remove immediately if animationend doesn't fire (e.g., in tests)
		setTimeout(() => {
			if (toast.parentNode) toast.remove();
		}, 500);
	}

	closeBtn.addEventListener("click", dismiss);
	const timer = setTimeout(dismiss, _duration);

	container.appendChild(toast);
}

/**
 * Polling state machine.
 * Polls as a fallback when SSE is disconnected; stops when SSE is active.
 */
export let sseConnected = false;
export let pollInterval: ReturnType<typeof setInterval> | null = null;

export function setSseConnected(value: boolean): void {
	sseConnected = value;
}

export function startPolling(refreshFn: () => void, intervalMs = 10000): void {
	if (pollInterval) return; // idempotent
	pollInterval = setInterval(refreshFn, intervalMs);
}

export function stopPolling(): void {
	if (pollInterval) {
		clearInterval(pollInterval);
		pollInterval = null;
	}
}

/**
 * Reset polling state (for tests).
 */
export function resetPollingState(): void {
	stopPolling();
	sseConnected = false;
}
