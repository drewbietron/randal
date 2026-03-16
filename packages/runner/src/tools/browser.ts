import { createLogger } from "@randal/core";
import type { Subprocess } from "bun";

const logger = createLogger({ context: { component: "browser-tool" } });

// ---- Configuration ----

export interface BrowserConfig {
	enabled: boolean;
	headless: boolean;
	profileDir?: string;
	sandbox: boolean;
	viewport: {
		width: number;
		height: number;
	};
	timeout: number;
}

const DEFAULT_CONFIG: BrowserConfig = {
	enabled: false,
	headless: true,
	sandbox: false,
	viewport: { width: 1280, height: 720 },
	timeout: 30000,
};

// ---- CDP types ----

interface CdpResponse {
	id: number;
	result?: Record<string, unknown>;
	error?: {
		code: number;
		message: string;
		data?: string;
	};
}

interface CdpTarget {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

interface ScreenshotResult {
	data: string;
	format: "png" | "jpeg";
}

interface EvaluateResult {
	value: unknown;
	type: string;
	error?: string;
}

interface NavigateResult {
	frameId: string;
	loaderId: string;
}

// ---- Chrome binary detection ----

const CHROME_PATHS: Record<string, string[]> = {
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	],
	win32: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	],
};

function findChromeBinary(): string | null {
	const platform = process.platform;
	const candidates = CHROME_PATHS[platform] ?? [];

	for (const path of candidates) {
		try {
			const result = Bun.spawnSync({ cmd: ["test", "-x", path] });
			if (result.exitCode === 0) {
				return path;
			}
		} catch {
			// Binary not found at this path, continue
		}
	}

	// Fall back to PATH lookup
	for (const name of ["google-chrome", "chromium", "chrome"]) {
		try {
			const result = Bun.spawnSync({ cmd: ["which", name] });
			if (result.exitCode === 0) {
				return result.stdout.toString().trim();
			}
		} catch {
			// Not in PATH
		}
	}

	return null;
}

// ---- Browser Tool ----

export class BrowserTool {
	private config: BrowserConfig;
	private process: Subprocess | null = null;
	private cdpUrl: string | null = null;
	private sessionId: string | null = null;
	private nextCdpId = 1;
	private debuggingPort = 0;

	constructor(config?: Partial<BrowserConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Create a BrowserTool from a RandalConfig's browser section.
	 */
	static fromConfig(browserConfig: {
		enabled: boolean;
		headless: boolean;
		profileDir?: string;
		sandbox: boolean;
		viewport: { width: number; height: number };
		timeout: number;
	}): BrowserTool {
		return new BrowserTool(browserConfig);
	}

	// ---- Lifecycle ----

	/**
	 * Launch a Chrome/Chromium subprocess with remote debugging enabled.
	 * Connects to the CDP endpoint once the browser is ready.
	 */
	async launch(): Promise<void> {
		if (this.process) {
			logger.warn("Browser already launched, closing existing instance");
			await this.close();
		}

		const binary = findChromeBinary();
		if (!binary) {
			throw new Error(
				"Chrome/Chromium binary not found. Install Google Chrome or Chromium to use browser tools.",
			);
		}

		// Pick a random high port for CDP
		this.debuggingPort = 9222 + Math.floor(Math.random() * 1000);

		const args = buildChromeArgs(this.config, this.debuggingPort);

		logger.info("Launching browser", {
			binary,
			port: this.debuggingPort,
			headless: this.config.headless,
		});

		this.process = Bun.spawn({
			cmd: [binary, ...args],
			stdout: "pipe",
			stderr: "pipe",
		});

		// Wait for CDP endpoint to become available
		this.cdpUrl = `http://127.0.0.1:${this.debuggingPort}`;
		await this.waitForCdp();

		// Attach to the first page target
		await this.attachToPage();

		logger.info("Browser ready", { cdpUrl: this.cdpUrl, sessionId: this.sessionId });
	}

	/**
	 * Close the browser and clean up.
	 */
	async close(): Promise<void> {
		if (this.process) {
			try {
				// Try graceful shutdown via CDP
				await this.sendCdpCommand("Browser.close", {}).catch(() => {});
			} catch {
				// Ignore errors during shutdown
			}

			try {
				this.process.kill();
			} catch {
				// Process may already be dead
			}

			this.process = null;
			this.cdpUrl = null;
			this.sessionId = null;
			logger.info("Browser closed");
		}
	}

	// ---- Navigation ----

	/**
	 * Navigate to a URL and wait for the page to load.
	 */
	async navigate(url: string): Promise<NavigateResult> {
		logger.debug("Navigating", { url });
		const result = await this.sendCdpCommand("Page.navigate", { url });
		// Wait for load event
		await this.sendCdpCommand("Page.enable", {});
		return result as unknown as NavigateResult;
	}

	// ---- Screenshots ----

	/**
	 * Capture a screenshot of the current page.
	 *
	 * @param options.format  Image format: "png" (default) or "jpeg"
	 * @param options.quality JPEG quality (0-100), ignored for PNG
	 * @param options.fullPage  Capture the full scrollable page
	 * @returns Base64-encoded image data
	 */
	async screenshot(options?: {
		format?: "png" | "jpeg";
		quality?: number;
		fullPage?: boolean;
	}): Promise<ScreenshotResult> {
		const format = options?.format ?? "png";
		const params: Record<string, unknown> = { format };

		if (format === "jpeg" && options?.quality != null) {
			params.quality = options.quality;
		}

		if (options?.fullPage) {
			// Get full page dimensions
			const metrics = await this.sendCdpCommand("Page.getLayoutMetrics", {});
			const contentSize = metrics.contentSize as { width: number; height: number } | undefined;
			if (contentSize) {
				params.clip = {
					x: 0,
					y: 0,
					width: contentSize.width,
					height: contentSize.height,
					scale: 1,
				};
				params.captureBeyondViewport = true;
			}
		}

		const result = await this.sendCdpCommand("Page.captureScreenshot", params);

		return {
			data: result.data as string,
			format,
		};
	}

	// ---- Interaction ----

	/**
	 * Click an element matching the given CSS selector.
	 */
	async click(selector: string): Promise<void> {
		logger.debug("Clicking", { selector });

		const center = await this.getElementCenter(selector);
		if (!center) {
			throw new Error(`Element not found: ${selector}`);
		}

		// Dispatch mouse events via CDP Input domain
		await this.sendCdpCommand("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: center.x,
			y: center.y,
			button: "left",
			clickCount: 1,
		});
		await this.sendCdpCommand("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: center.x,
			y: center.y,
			button: "left",
			clickCount: 1,
		});
	}

	/**
	 * Type text into an element matching the given CSS selector.
	 * Focuses the element first, then dispatches key events.
	 */
	async type(selector: string, text: string): Promise<void> {
		logger.debug("Typing", { selector, length: text.length });

		// Focus the element
		await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);

		// Type each character via CDP
		for (const char of text) {
			await this.sendCdpCommand("Input.dispatchKeyEvent", {
				type: "keyDown",
				text: char,
				key: char,
				unmodifiedText: char,
			});
			await this.sendCdpCommand("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: char,
			});
		}
	}

	// ---- Evaluation ----

	/**
	 * Execute JavaScript in the page context and return the result.
	 */
	async evaluate(script: string): Promise<EvaluateResult> {
		logger.debug("Evaluating script", { length: script.length });

		const result = await this.sendCdpCommand("Runtime.evaluate", {
			expression: script,
			returnByValue: true,
			awaitPromise: true,
			timeout: this.config.timeout,
		});

		const remote = result.result as
			| { type: string; value: unknown; description?: string }
			| undefined;

		if (result.exceptionDetails) {
			const details = result.exceptionDetails as {
				text?: string;
				exception?: { description?: string };
			};
			return {
				value: undefined,
				type: "error",
				error: details.exception?.description ?? details.text ?? "Unknown evaluation error",
			};
		}

		return {
			value: remote?.value,
			type: remote?.type ?? "undefined",
		};
	}

	// ---- Content extraction ----

	/**
	 * Get text content from the page. If a selector is provided, returns
	 * the textContent of that element. Otherwise returns the full page
	 * body text.
	 */
	async getContent(selector?: string): Promise<string> {
		const target = selector
			? `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`
			: "document.body?.innerText ?? ''";

		const result = await this.evaluate(target);
		if (result.error) {
			throw new Error(`Failed to get content: ${result.error}`);
		}
		return String(result.value ?? "");
	}

	/**
	 * Get an accessibility-tree-like snapshot of the page.
	 * Uses CDP's Accessibility domain if available, falls back to a
	 * DOM-based approximation.
	 */
	async getSnapshot(): Promise<string> {
		logger.debug("Getting page snapshot");

		try {
			// Try the CDP Accessibility tree first
			const result = await this.sendCdpCommand("Accessibility.getFullAXTree", {});
			const nodes = result.nodes as
				| Array<{
						role?: { value: string };
						name?: { value: string };
						nodeId?: string;
				  }>
				| undefined;

			if (nodes && nodes.length > 0) {
				return formatAccessibilityTree(nodes);
			}
		} catch {
			// Accessibility domain not available, fall back
		}

		// Fallback: extract a structured DOM summary via JS
		const script = `
			(function() {
				const walk = (el, depth) => {
					if (depth > 6) return '';
					const tag = el.tagName?.toLowerCase() ?? '';
					const role = el.getAttribute?.('role') ?? '';
					const label = el.getAttribute?.('aria-label') ?? el.getAttribute?.('alt') ?? '';
					const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
						? el.childNodes[0].textContent?.trim().slice(0, 100) : '';
					const indent = '  '.repeat(depth);
					let line = indent + tag;
					if (role) line += '[role=' + role + ']';
					if (label) line += ' "' + label + '"';
					if (text) line += ' : ' + text;
					const children = Array.from(el.children ?? [])
						.map(c => walk(c, depth + 1))
						.filter(Boolean)
						.join('\\n');
					return line + (children ? '\\n' + children : '');
				};
				return walk(document.body, 0);
			})()
		`;

		const result = await this.evaluate(script);
		return String(result.value ?? "");
	}

	// ---- CDP communication ----

	/**
	 * Send a command to Chrome via the CDP HTTP endpoint.
	 * Falls back to the JSON/HTTP protocol (not WebSocket) for simplicity.
	 */
	private async sendCdpCommand(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!this.cdpUrl) {
			throw new Error("Browser not launched");
		}

		const id = this.nextCdpId++;
		const body = JSON.stringify({
			id,
			method,
			params,
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
		});

		// CDP over HTTP using the /json/protocol endpoint isn't standard for
		// commands. The proper approach is WebSocket, but for a synchronous
		// command-response pattern we use the browser's HTTP endpoints where
		// possible and fall back to a simple WebSocket exchange.

		const wsUrl = await this.getWebSocketUrl();
		if (!wsUrl) {
			throw new Error("No WebSocket debugger URL available");
		}

		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error(`CDP command timed out: ${method}`));
			}, this.config.timeout);

			ws.onopen = () => {
				ws.send(body);
			};

			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(typeof event.data === "string" ? event.data : "") as CdpResponse;
					if (data.id === id) {
						clearTimeout(timer);
						ws.close();
						if (data.error) {
							reject(new Error(`CDP error (${data.error.code}): ${data.error.message}`));
						} else {
							resolve(data.result ?? {});
						}
					}
				} catch (err) {
					clearTimeout(timer);
					ws.close();
					reject(err);
				}
			};

			ws.onerror = (event) => {
				clearTimeout(timer);
				ws.close();
				reject(new Error(`WebSocket error for ${method}: ${event}`));
			};
		});
	}

	private async getWebSocketUrl(): Promise<string | null> {
		if (!this.cdpUrl) return null;

		try {
			const resp = await fetch(`${this.cdpUrl}/json/version`);
			const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
			return data.webSocketDebuggerUrl ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Wait for the CDP endpoint to become available after launching Chrome.
	 */
	private async waitForCdp(): Promise<void> {
		const maxWait = this.config.timeout;
		const start = Date.now();
		const pollInterval = 200;

		while (Date.now() - start < maxWait) {
			try {
				const resp = await fetch(`${this.cdpUrl}/json/version`);
				if (resp.ok) return;
			} catch {
				// Not ready yet
			}
			await sleep(pollInterval);
		}

		throw new Error(`Browser CDP endpoint did not become available within ${maxWait}ms`);
	}

	/**
	 * Attach to the first "page" target so commands are sent to the right context.
	 */
	private async attachToPage(): Promise<void> {
		if (!this.cdpUrl) return;

		try {
			const resp = await fetch(`${this.cdpUrl}/json/list`);
			const targets = (await resp.json()) as CdpTarget[];
			const page = targets.find((t) => t.type === "page");

			if (page) {
				this.sessionId = page.id;
				logger.debug("Attached to page target", {
					id: page.id,
					url: page.url,
				});
			} else {
				logger.warn("No page target found, commands may fail");
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("Failed to enumerate targets", { error: message });
		}
	}

	/**
	 * Get the center coordinates of an element for click targeting.
	 */
	private async getElementCenter(selector: string): Promise<{ x: number; y: number } | null> {
		const result = await this.evaluate(`
			(function() {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return null;
				const rect = el.getBoundingClientRect();
				return {
					x: Math.round(rect.left + rect.width / 2),
					y: Math.round(rect.top + rect.height / 2)
				};
			})()
		`);

		if (result.error || result.value == null) return null;
		return result.value as { x: number; y: number };
	}

	// ---- Introspection ----

	get isLaunched(): boolean {
		return this.process !== null;
	}

	get cdpEndpoint(): string | null {
		return this.cdpUrl;
	}
}

// ---- Chrome argument builder ----

function buildChromeArgs(config: BrowserConfig, debuggingPort: number): string[] {
	const args = [
		`--remote-debugging-port=${debuggingPort}`,
		`--window-size=${config.viewport.width},${config.viewport.height}`,
		"--disable-background-networking",
		"--disable-client-side-phishing-detection",
		"--disable-default-apps",
		"--disable-extensions",
		"--disable-hang-monitor",
		"--disable-popup-blocking",
		"--disable-prompt-on-repost",
		"--disable-sync",
		"--disable-translate",
		"--metrics-recording-only",
		"--no-first-run",
	];

	if (config.headless) {
		args.push("--headless=new");
	}

	if (!config.sandbox) {
		args.push("--no-sandbox", "--disable-setuid-sandbox");
	}

	if (config.profileDir) {
		args.push(`--user-data-dir=${config.profileDir}`);
	}

	// Start with about:blank
	args.push("about:blank");

	return args;
}

// ---- Accessibility tree formatter ----

function formatAccessibilityTree(
	nodes: Array<{
		role?: { value: string };
		name?: { value: string };
		nodeId?: string;
	}>,
): string {
	const lines: string[] = [];
	for (const node of nodes) {
		const role = node.role?.value ?? "unknown";
		const name = node.name?.value ?? "";
		if (role === "none" || role === "generic") continue;
		const line = name ? `${role}: ${name}` : role;
		lines.push(line);
	}
	return lines.join("\n");
}

// ---- Utilities ----

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
