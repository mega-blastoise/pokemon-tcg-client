/** @module client_entry Provides a browser-safe default for runtimes without a native export match. */
// The default graph is deliberately browser safe. Native runtimes select their
// dedicated package export, never a runtime branch containing native imports.
export * from "./browser.js";
