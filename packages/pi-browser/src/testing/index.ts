// Test support for the package and for any host that composes it: one fake provider backend (with a ledger, a
// credential broker and an HTTP face that outlives a killed child), a driver over in-memory pages, fixture pages and
// the sentinel credentials. Shipped so a host's composition test and the package's crash matrix use the same fake.
export * from "./backend.js";
export * from "./driver.js";
export * from "./pages.js";
export * from "./sentinels.js";
