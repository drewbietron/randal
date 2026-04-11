/**
 * Test setup: register happy-dom globals (document, window, etc.)
 * so DOM-dependent code works in bun:test.
 */
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost" });

// Assign all standard DOM globals from the happy-dom Window instance
const globals = [
	"document",
	"HTMLElement",
	"HTMLDivElement",
	"HTMLButtonElement",
	"Node",
	"Event",
	"MutationObserver",
	"CustomEvent",
	"navigator",
	"NodeList",
	"Element",
	"DocumentFragment",
	"Text",
	"Comment",
	"DOMParser",
	"XMLSerializer",
	"NodeFilter",
] as const;

for (const key of globals) {
	// biome-ignore lint/suspicious/noExplicitAny: happy-dom Window lacks full type coverage for indexed access
	if ((win as any)[key] !== undefined) {
		// biome-ignore lint/suspicious/noExplicitAny: patching globalThis requires dynamic key assignment
		(globalThis as any)[key] = (win as any)[key];
	}
}

// The Window object itself must be available as globalThis.window
// AND the window must have reference to native error constructors
// (happy-dom's querySelector uses this.window.SyntaxError internally)
// biome-ignore lint/suspicious/noExplicitAny: happy-dom Window missing native error constructor types
(win as any).SyntaxError = globalThis.SyntaxError;
// biome-ignore lint/suspicious/noExplicitAny: happy-dom Window missing native error constructor types
(win as any).TypeError = globalThis.TypeError;
// biome-ignore lint/suspicious/noExplicitAny: happy-dom Window missing native error constructor types
(win as any).RangeError = globalThis.RangeError;
// biome-ignore lint/suspicious/noExplicitAny: happy-dom Window missing native error constructor types
(win as any).Error = globalThis.Error;

// biome-ignore lint/suspicious/noExplicitAny: globalThis.window not in standard TS lib types
(globalThis as any).window = win;
// biome-ignore lint/suspicious/noExplicitAny: globalThis.document typing mismatch with happy-dom
(globalThis as any).document = win.document;
