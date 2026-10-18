// Test support for the package and for any host that composes it: fake eyes with scripted answers, a ledger of every
// request and a sentinel key; fake speech-to-text providers; a fixture directory and a PNG writer; and the conformance suite every provider passes,
// with a fake provider that proves the suite itself; fixture builders and the leak check. Shipped so a host's composition
// test uses the same fakes.
export * from "./builders.js";
export * from "./conformance.js";
export * from "./eyes.js";
export * from "./fixtures.js";
export * from "./leaks.js";
export * from "./sentinels.js";
export * from "./transcribers.js";
