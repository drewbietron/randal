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
	if ((win as any)[key] !== undefined) {
		(globalThis as any)[key] = (win as any)[key];
	}
}

// The Window object itself must be available as globalThis.window
// AND the window must have reference to native error constructors
// (happy-dom's querySelector uses this.window.SyntaxError internally)
(win as any).SyntaxError = globalThis.SyntaxError;
(win as any).TypeError = globalThis.TypeError;
(win as any).RangeError = globalThis.RangeError;
(win as any).Error = globalThis.Error;

(globalThis as any).window = win;
(globalThis as any).document = win.document;
