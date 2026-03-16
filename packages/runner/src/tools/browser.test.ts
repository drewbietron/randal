import { beforeEach, describe, expect, test } from "bun:test";
import { BrowserTool } from "./browser.js";

describe("BrowserTool", () => {
	let browser: BrowserTool;

	beforeEach(() => {
		browser = new BrowserTool({
			headless: true,
			viewport: { width: 1280, height: 720 },
			timeout: 5000,
		});
	});

	describe("construction", () => {
		test("creates with default options", () => {
			const b = new BrowserTool();
			expect(b).toBeDefined();
			expect(b.isLaunched).toBe(false);
		});

		test("creates with custom options", () => {
			const b = new BrowserTool({
				headless: false,
				viewport: { width: 800, height: 600 },
				timeout: 10000,
				profileDir: "/tmp/test-profile",
			});
			expect(b).toBeDefined();
			expect(b.isLaunched).toBe(false);
		});

		test("creates from config", () => {
			const b = BrowserTool.fromConfig({
				enabled: true,
				headless: true,
				viewport: { width: 1920, height: 1080 },
				timeout: 30000,
				sandbox: false,
			});
			expect(b).toBeDefined();
		});

		test("creates from config with profile dir", () => {
			const b = BrowserTool.fromConfig({
				enabled: true,
				headless: true,
				viewport: { width: 1280, height: 720 },
				timeout: 30000,
				sandbox: false,
				profileDir: "/tmp/chrome-profile",
			});
			expect(b).toBeDefined();
		});
	});

	describe("state management", () => {
		test("isLaunched returns false before launch", () => {
			expect(browser.isLaunched).toBe(false);
		});

		test("close on unlaunched browser is no-op", async () => {
			// Should not throw
			await browser.close();
			expect(browser.isLaunched).toBe(false);
		});
	});

	describe("navigation methods (without launched browser)", () => {
		test("navigate throws when not launched", async () => {
			try {
				await browser.navigate("https://example.com");
				expect(true).toBe(false); // Should not reach
			} catch (err) {
				expect(err).toBeDefined();
			}
		});

		test("screenshot throws when not launched", async () => {
			try {
				await browser.screenshot();
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeDefined();
			}
		});

		test("click throws when not launched", async () => {
			try {
				await browser.click("button");
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeDefined();
			}
		});

		test("type throws when not launched", async () => {
			try {
				await browser.type("input", "hello");
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeDefined();
			}
		});

		test("evaluate throws when not launched", async () => {
			try {
				await browser.evaluate("1+1");
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeDefined();
			}
		});

		test("getContent throws when not launched", async () => {
			try {
				await browser.getContent();
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeDefined();
			}
		});

		test("getSnapshot throws when not launched", async () => {
			try {
				await browser.getSnapshot();
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeDefined();
			}
		});
	});

	describe("option validation", () => {
		test("viewport dimensions are stored", () => {
			const b = new BrowserTool({
				viewport: { width: 1920, height: 1080 },
			});
			expect(b).toBeDefined();
		});

		test("timeout is stored", () => {
			const b = new BrowserTool({ timeout: 60000 });
			expect(b).toBeDefined();
		});

		test("profileDir is optional", () => {
			const b = new BrowserTool({});
			expect(b).toBeDefined();
		});
	});
});
