// A browser provider's own record of a session (BrowserComputerProvider.sessionUsage): Browserbase's, read from GET
// /v1/sessions/{id} on its fake (test/fake-browser.mjs), its start, end and proxy bytes, each null where the vendor's
// answer does not say it, never a zero in its place. No network, no account.
import assert from "node:assert/strict";
import test from "node:test";
import { BROWSERBASE_KEY, BROWSERBASE_URL, fakeBrowserbase } from "./fake-browser.mjs";

const { BrowserbaseProvider } = await import("../dist/browserbase.js");
const make = (fake) => new BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: fake.fetch, sleep: async () => {} });
const spec = { image: "chromium", lifetimeMs: 600_000, network: "open", labels: {} };

test("Browserbase's record of a released session: its start, its end and its proxy bytes", async () => {
	const fake = fakeBrowserbase({ proxyBytes: 123_456 });
	const provider = make(fake);
	const made = await provider.create(spec, { requestId: "r1" });
	assert.ok(made.ok, JSON.stringify(made));
	assert.ok((await provider.release(made.value, "delete")).ok);
	const usage = await provider.sessionUsage(made.value);
	assert.ok(usage.ok, JSON.stringify(usage));
	const held = fake.sessions.get(made.value.id);
	assert.deepEqual(usage.value, { startedAt: held.startedAt, endedAt: held.endedAt, proxyBytes: 123_456 });
	assert.equal(Date.parse(usage.value.endedAt) - Date.parse(usage.value.startedAt), 90_000);
	assert.equal(fake.only("GET", `/v1/sessions/${made.value.id}`).length >= 1, true, "read by its id");
});

test("a field Browserbase does not give is null, never 0: a running session has no end, and no proxy bytes were reported", async () => {
	const fake = fakeBrowserbase();
	const provider = make(fake);
	const made = await provider.create(spec, { requestId: "r2" });
	const usage = await provider.sessionUsage(made.value);
	assert.ok(usage.ok);
	assert.equal(usage.value.endedAt, null);
	assert.equal(usage.value.proxyBytes, null);
	assert.equal(typeof usage.value.startedAt, "string");
	// A malformed figure is no figure.
	fake.sessions.get(made.value.id).proxyBytes = -5;
	fake.sessions.get(made.value.id).endedAt = "not a date";
	const odd = await provider.sessionUsage(made.value);
	assert.deepEqual([odd.value.endedAt, odd.value.proxyBytes], [null, null]);
});

test("a session Browserbase does not know is undefined; a failed read is a failure, not an empty record", async () => {
	const fake = fakeBrowserbase();
	const provider = make(fake);
	const unknown = await provider.sessionUsage({ id: "sess_404", name: "sess_404" });
	assert.ok(unknown.ok);
	assert.equal(unknown.value, undefined);
	const broken = new BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: async () => new Response("down", { status: 503 }), sleep: async () => {} });
	const failed = await broken.sessionUsage({ id: "sess_1", name: "sess_1" });
	assert.equal(failed.ok, false);
	assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
});
