// A browser session's own options and features (CP-4): capabilities().browser declares what a browser provider's
// sessions offer beyond the protocol, spec.browser asks for it, and check() refuses, in words and before any vendor call,
// an option the provider does not declare. Each provider maps the options to its own create body: Browserbase's
// browserSettings (viewport, a context as the profile, stealth as Verified with the CAPTCHA solver); Kernel's viewport,
// headless and profile; Local Chrome's viewport, as its window. The optional members are profiles { create, remove }
// (Browserbase contexts, Kernel profiles) and downloads { list, read } (Browserbase alone). Over the fake vendors
// (test/fake-browser.mjs): no network. No pointer, key or signed URL reaches an error's words.
import assert from "node:assert/strict";
import test from "node:test";
import { browserSpecRefusals, isBrowserProvider } from "../dist/index.js";
import { BROWSERBASE_KEY, BROWSERBASE_URL, fakeBrowserbase, fakeKernel, KERNEL_KEY, KERNEL_URL } from "./fake-browser.mjs";

const HOUR = 3_600_000;
const noSleep = async () => {};
const spec = (browser, labels = { "agentrun.run": "run-1" }) => ({ image: "chromium", lifetimeMs: HOUR, network: "open", labels, ...(browser === undefined ? {} : { browser }) });
const value = (result, what) => {
	assert.ok(result.ok, `${what}: ${JSON.stringify(result)}`);
	return result.value;
};

const browserbase = async (fake, extra = {}) => new (await import("../dist/browserbase.js")).BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: fake.fetch, sleep: noSleep, ...extra });
const kernel = async (fake, extra = {}) => new (await import("../dist/kernel.js")).KernelProvider({ apiKey: KERNEL_KEY, apiUrl: KERNEL_URL, fetch: fake.fetch, sleep: noSleep, ...extra });

test("a browser provider declares its sessions' features in capabilities().browser, and is told apart by them", async () => {
	const bb = await browserbase(fakeBrowserbase());
	const kn = await kernel(fakeKernel());
	const local = new (await import("../dist/local-chrome.js")).LocalBrowserProvider({ executablePath: "/bin/true", root: "/tmp/agentrun-browser-session-test" });
	assert.deepEqual(bb.capabilities().browser, { timeout: "wall-clock", stealth: true, profiles: { settleMs: 5_000 }, downloads: { path: "downloads" } });
	assert.deepEqual(kn.capabilities().browser, { timeout: "inactivity", profiles: { settleMs: 0 }, headless: true });
	assert.deepEqual(local.capabilities().browser, { timeout: "wall-clock" }, "Local Chrome's sessions end at their deadline and take a viewport alone");
	assert.ok(isBrowserProvider(bb) && isBrowserProvider(kn) && isBrowserProvider(local));
	assert.equal(typeof bb.profiles?.create, "function");
	assert.equal(typeof bb.downloads?.list, "function", "Browserbase keeps a session's downloads");
	assert.equal(typeof kn.profiles?.remove, "function");
	assert.equal(kn.downloads, undefined, "Kernel's downloads are not wired");
	// A copy: a caller that changes what it was given changes nothing of the provider's.
	bb.capabilities().browser.stealth = false;
	assert.equal(bb.capabilities().browser.stealth, true);
	assert.equal(isBrowserProvider({ capabilities: () => ({ kind: "linux" }) }), false);
	assert.equal(isBrowserProvider({ capabilities: () => ({ kind: "browser" }) }), false, "a browser that declares no features is not one a host can open sessions on");
});

test("check() refuses an option the provider does not declare, in words, before any call; a flag set false asks for nothing", async () => {
	const bbFake = fakeBrowserbase();
	const bb = await browserbase(bbFake);
	const knFake = fakeKernel();
	const kn = await kernel(knFake);
	const fields = (refusals) => refusals.map((r) => r.field);
	assert.deepEqual(fields(bb.check(spec({ headless: true }))), ["browser.headless"], "Browserbase has no headless mode");
	assert.match(bb.check(spec({ headless: true }))[0].message, /a Browserbase browser has no headless mode/);
	assert.deepEqual(fields(kn.check(spec({ stealth: true }))), ["browser.stealth"], "Kernel's stealth mode is not declared");
	assert.deepEqual(bb.check(spec({ headless: false })), [], "false asks for nothing");
	assert.deepEqual(kn.check(spec({ stealth: false, headless: true, viewport: { width: 1280, height: 800 } })), []);
	assert.deepEqual(fields(bb.check(spec({ viewport: { width: 0, height: 800 } }))), ["browser.viewport"]);
	assert.deepEqual(fields(bb.check(spec({ verified: true }))), ["browser.verified"], "the option is stealth, not verified");
	assert.deepEqual(fields(bb.check(spec({ extension: { archive: "/x.zip" } }))), ["browser.extension"], "a browser loads no extension");
	assert.deepEqual(fields(bb.check(spec("open"))), ["browser"]);
	const pointer = "SECRET-POINTER/../x";
	const refused = bb.check(spec({ profile: { pointer, save: true } }));
	assert.deepEqual(fields(refused), ["browser.profile"]);
	assert.ok(!JSON.stringify(refused).includes("SECRET-POINTER"), "the words never carry a pointer");
	assert.deepEqual(fields(browserSpecRefusals({ profile: { pointer: "p", save: false } }, { timeout: "wall-clock" }, "Bare")), ["browser.profile"], "a provider that declares no profiles refuses one");
	const create = await bb.create(spec({ headless: true }));
	assert.equal(create.ok, false);
	assert.equal(create.error.code, "refused");
	assert.match(create.error.message, /browser\.headless: a Browserbase browser has no headless mode/);
	assert.equal(bbFake.calls.length, 0, "no vendor call for a refused create");
	assert.equal((await kn.create(spec({ stealth: true }))).ok, false);
	assert.equal(knFake.calls.length, 0);
});

test("Browserbase: spec.browser rides its create body as browserSettings", async () => {
	const fake = fakeBrowserbase();
	const a = await browserbase(fake);
	const made = value(await a.create(spec({ viewport: { width: 1288, height: 711 }, stealth: true, profile: { pointer: "ctx_7", save: true } })), "create");
	const [body] = fake.only("POST", "/v1/sessions").map((call) => call.body);
	assert.deepEqual(body.browserSettings, { viewport: { width: 1288, height: 711 }, solveCaptchas: true, verified: true, context: { id: "ctx_7", persist: true } });
	assert.equal(body.extensionId, undefined);
	assert.equal(body.keepAlive, true);
	assert.ok(fake.sessions.has(made.id));
	value(await a.create(spec({ viewport: { width: 1280, height: 800 } })), "a second create");
	assert.deepEqual(fake.only("POST", "/v1/sessions")[1].body.browserSettings, { viewport: { width: 1280, height: 800 }, solveCaptchas: false }, "the solver is off unless stealth asks it, as Browserbase's default is on");
	// A create that asks no browser options sends the body as before.
	value(await a.create(spec()), "a plain create");
	assert.equal(fake.only("POST", "/v1/sessions")[2].body.browserSettings, undefined);
});

test("Browserbase: profiles are contexts; a pointer is in no error's words", async () => {
	const fake = fakeBrowserbase();
	const p = await browserbase(fake, { projectId: "proj_fake" });
	const pointer = value(await p.profiles.create(), "profiles.create");
	assert.equal(pointer, "ctx_1");
	assert.deepEqual(fake.contexts.get(pointer), { projectId: "proj_fake" });
	value(await p.profiles.remove(pointer), "profiles.remove");
	assert.equal(fake.contexts.has(pointer), false);
	value(await p.profiles.remove(pointer), "a context Browserbase no longer knows is removed");
	const bad = await p.profiles.remove("SECRET/../x");
	assert.equal(bad.ok, false);
	assert.ok(!bad.error.message.includes("SECRET"));
});

test("Browserbase: downloads lists a session's files page by page, and reads one by name within maxBytes", async () => {
	const many = Array.from({ length: 130 }, (_, i) => ({ id: `dl_${i}`, filename: `file-${i}.txt`, size: 5, createdAt: "2026-11-10T12:00:00.000Z", bytes: Buffer.from(`f${String(i).padStart(3, "0")}`) }));
	// The fake's first session is sess_1: its downloads, as Browserbase synced them.
	const listed = fakeBrowserbase({ downloads: { sess_1: [...many, { id: "dl_big", filename: "big.bin", size: 10, createdAt: null, bytes: Buffer.alloc(10) }] } });
	const q = await browserbase(listed);
	const made = value(await q.create(spec()), "create");
	assert.equal(made.id, "sess_1");
	const files = value(await q.downloads.list(made), "downloads.list");
	assert.equal(files.length, 131, "every page read, by total");
	assert.deepEqual(files[0], { name: "file-0.txt", sizeBytes: 5, modifiedAt: "2026-11-10T12:00:00.000Z" });
	assert.equal(listed.only("GET", "/v1/downloads").length, 2);
	const read = value(await q.downloads.read(made, "file-7.txt", 100), "downloads.read");
	const chunks = [];
	for await (const chunk of read) chunks.push(Buffer.from(chunk));
	assert.equal(Buffer.concat(chunks).toString(), "f007");
	const big = await q.downloads.read(made, "big.bin", 4);
	assert.equal(big.ok, false);
	assert.equal(big.error.code, "limit");
	const none = await q.downloads.read(made, "nope.txt", 100);
	assert.equal(none.error.code, "not_found");
});

test("Kernel: spec.browser rides its create body; a profile it does not know is made first", async () => {
	const fake = fakeKernel();
	const a = await kernel(fake);
	value(await a.create(spec({ viewport: { width: 1288, height: 711 }, headless: true, profile: { pointer: "agentrun-p1", save: true } })), "create");
	const [body] = fake.only("POST", "/browsers").map((call) => call.body);
	assert.equal(body.stealth, false);
	assert.deepEqual(body.viewport, { width: 1288, height: 711 });
	assert.equal(body.headless, true);
	assert.deepEqual(body.profile, { name: "agentrun-p1", save_changes: true });
	assert.equal(body.extensions, undefined);
	assert.ok(fake.profiles.has("agentrun-p1"), "the profile was made before the browser named it");
	value(await a.create(spec({ profile: { pointer: "agentrun-p1", save: false } })), "a second create");
	assert.equal(fake.only("POST", "/profiles").length, 1, "a profile Kernel knows is not made again");
});

test("Kernel: profiles are Kernel profiles under a random name, which is the pointer; a pointer is in no error's words", async () => {
	const fake = fakeKernel();
	const p = await kernel(fake);
	const pointer = value(await p.profiles.create(), "profiles.create");
	assert.match(pointer, /^agentrun-[0-9a-f]{24}$/);
	assert.ok(fake.profiles.has(pointer));
	value(await p.profiles.remove(pointer), "profiles.remove");
	assert.equal(fake.profiles.has(pointer), false);
	const failed = await (await kernel(fakeKernel(), { apiKey: "wrong" })).profiles.create();
	assert.equal(failed.ok, false);
	assert.equal(failed.error.code, "denied");
	assert.ok(!failed.error.message.includes("agentrun-"), "the words name the call, never the profile");
});
