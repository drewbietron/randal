/**
 * Dashboard entry point.
 * The dashboard is a single HTML file with inline CSS and JS.
 * This module provides a helper to read the HTML at build time.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get the dashboard HTML content.
 */
export function getDashboardHtml(): string {
	return readFileSync(join(__dirname, "index.html"), "utf-8");
}
