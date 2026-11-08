// A browser is a computer kind: linux, daemon none, answering CDP. Browserbase and Kernel are its providers, each over
// its vendor's REST API (test/fake-browser.mjs): labels ride the vendor session's own metadata, attach and list find a
// session by them, connect hands over the signed CDP URL, stream the live view, release is idempotent, and check()
// refuses a lifetime past the vendor's cap before any call. Neither URL is ever in a ref, a list, an error or JSON.
import assert from "node:assert/strict";
import test from "node:test";
import { coreGroups, GROUPS, KIND_SHAPES, kindRefusals } from "../dist/index.js";
import { providerFor, providerIds, providerModule } from "../dist/providers.js";
import { BROWSERBASE_KEY, BROWSERBASE_URL, ECHO, fakeBrowserbase, fakeKernel, KERNEL_KEY, KERNEL_URL } from "./fake-browser.mjs";

const HOUR = 3_600_000;
const SECRET = /SECRET/;
const noSleep = async () => {};

const VENDORS = {
	browserbase: {
		fake: fakeBrowserbase,
		async make(fake, extra = {}) {
			const { BrowserbaseProvider } = await import("../dist/browserbase.js");
			return new BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: fake.fetch, sleep: noSleep, ...extra });
		},
		capabilities: {
			kind: "browser",
			lifetime: "vendor",
			network: ["open"],
			isolation: "vm",
			os: "linux",
			daemon: "none",
			groups: ["cdp", "stream"],
			maxLifetimeMs: 6 * HOUR,
			release: ["delete"],
		},
		/** The labels as the vendor holds them, on the session it made. */
		held: (fake, id) => fake.sessions.get(id).userMetadata,
		lifetime: (fake, id) => fake.sessions.get(id).expiresAt,
		creates: (fake) => fake.only("POST", "/v1/sessions"),
	},
	kernel: {
		fake: fakeKernel,
		async make(fake, extra = {}) {
			const { KernelProvider } = await import("../dist/kernel.js");
			return new KernelProvider({ apiKey: KERNEL_KEY, apiUrl: KERNEL_URL, fetch: fake.fetch, sleep: noSleep, ...extra });
		},
		capabilities: {
			kind: "browser",
			lifetime: "vendor",
			network: ["open"],
			isolation: "vm",
			os: "linux",
			daemon: "none",
			groups: ["cdp", "stream"],
			maxLifetimeMs: 72 * HOUR,
			release: ["delete"],
		},
		held: (fake, id) => fake.browsers.get(id).tags,
		lifetime: (fake, id) => fake.browsers.get(id).timeout,
		creates: (fake) => fake.only("POST", "/browsers"),
	},
};

/** Runs fn with these variables set in process.env, then puts it back: a provider that read them would show it. */
async function withProcessEnv(vars, fn) {
	const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
	Object.assign(process.env, vars);
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

const spec = (extra = {}) => ({ image: "chromium", lifetimeMs: 30 * 60_000, network: "open", labels: { "agentrun.run": "run-1", job: "j-42" }, ...extra });
const value = (result, what) => {
	assert.ok(result.ok, `${what}: ${result.ok ? "" : `${result.error.code}: ${result.error.message}`}`);
	return result.value;
};

test("a browser is a kind: linux, daemon none, Core cdp; its groups are the protocol's", () => {
	assert.deepEqual(KIND_SHAPES.browser, { os: ["linux"], daemon: ["none"] });
	assert.deepEqual(kindRefusals({ kind: "browser", os: "linux", daemon: "none" }), []);
	assert.match(kindRefusals({ kind: "browser", os: "linux", daemon: "pid1" })[0].message, /a browser computer has daemon none, not "pid1"/);
	assert.match(kindRefusals({ kind: "browser", os: "windows", daemon: "none" })[0].message, /a browser computer runs linux, not os "windows"/);
	for (const group of ["cdp", "stream", "downloads"]) assert.ok(GROUPS.includes(group), `GROUPS holds ${group}`);
	assert.deepEqual(coreGroups("browser", "none"), ["cdp"]);
});

test("the registry holds browserbase and kernel, each built from its options alone; the conformance side reads COMPUTER_<ID>_* only", async () => {
	for (const id of ["browserbase", "kernel"]) assert.ok(providerIds.includes(id), `the registry holds ${id}`);
	await withProcessEnv({ BROWSERBASE_API_KEY: "bare-key-must-not-be-used", COMPUTER_BROWSERBASE_API_KEY: "bare-key-must-not-be-used", KERNEL_API_KEY: "bare-key-must-not-be-used", COMPUTER_KERNEL_API_KEY: "bare-key-must-not-be-used" }, async () => {
		for (const id of ["browserbase", "kernel"]) {
			await assert.rejects(providerFor(id, {}), (error) => {
				assert.match(error.message, /options\.apiKey/);
				assert.doesNotMatch(error.message, /bare-key-must-not-be-used/);
				return true;
			});
		}
	});
	assert.equal((await providerFor("browserbase", { apiKey: BROWSERBASE_KEY })).id, "browserbase");
	assert.equal((await providerFor("kernel", { apiKey: KERNEL_KEY })).id, "kernel");
	await assert.rejects(async () => (await providerFor("kernel", { apiKey: KERNEL_KEY, apiUrl: "http://api.kernel.test" })), /https/);
	const browserbase = await (await providerModule("browserbase")).conformance();
	assert.deepEqual(browserbase.ENV, { live: "AGENTRUN_COMPUTER_LIVE_BROWSERBASE", key: "COMPUTER_BROWSERBASE_API_KEY", project: "COMPUTER_BROWSERBASE_PROJECT_ID", url: "COMPUTER_BROWSERBASE_API_URL" });
	assert.deepEqual(browserbase.settingsFromEnv({ COMPUTER_BROWSERBASE_API_KEY: "k", COMPUTER_BROWSERBASE_PROJECT_ID: "p" }), { apiKey: "k", projectId: "p" });
	assert.throws(() => browserbase.settingsFromEnv({ BROWSERBASE_API_KEY: "bare-key-must-not-be-used" }), (error) => /COMPUTER_BROWSERBASE_API_KEY/.test(error.message) && !/bare-key-must-not-be-used/.test(error.message));
	const kernel = await (await providerModule("kernel")).conformance();
	assert.deepEqual(kernel.ENV, { live: "AGENTRUN_COMPUTER_LIVE_KERNEL", key: "COMPUTER_KERNEL_API_KEY", url: "COMPUTER_KERNEL_API_URL" });
	assert.throws(() => kernel.settingsFromEnv({ KERNEL_API_KEY: "bare-key-must-not-be-used" }), (error) => /COMPUTER_KERNEL_API_KEY/.test(error.message) && !/bare-key-must-not-be-used/.test(error.message));
});

for (const [id, vendor] of Object.entries(VENDORS)) {
	test(`${id}: capabilities() declares a browser: vendor lifetime, open network, vm, daemon none, release delete, the vendor's cap`, async () => {
		const provider = await vendor.make(vendor.fake());
		assert.equal(provider.id, id);
		assert.deepEqual(provider.capabilities(), vendor.capabilities);
		assert.deepEqual(kindRefusals(provider.capabilities()), []);
		assert.equal(provider.extend, undefined, "no extend: the vendor moves no running session's timeout");
	});

	test(`${id}: create writes the labels into the vendor session's metadata; attach by id and by labels, and list, find it`, async () => {
		const fake = vendor.fake();
		const provider = await vendor.make(fake);
		const created = value(await provider.create(spec()), "create");
		assert.deepEqual(Object.keys(created).sort(), ["id", "name"]);
		assert.deepEqual(vendor.held(fake, created.id), { "agentrun.run": "run-1", job: "j-42" }, "the labels, as the vendor holds them");
		assert.equal(vendor.lifetime(fake, created.id) !== undefined, true, "the lifetime rides the create");
		value(await provider.create(spec({ labels: { "agentrun.run": "run-2" } })), "another run's");
		const byId = value(await provider.attach({ id: created.id }), "attach by id");
		assert.deepEqual({ id: byId.id, name: byId.name }, created);
		assert.equal(byId.spec.kind, "browser");
		assert.equal(byId.spec.network, "open");
		const byLabels = value(await provider.attach({ labels: { "agentrun.run": "run-1" } }), "attach by labels");
		assert.deepEqual({ id: byLabels.id, name: byLabels.name }, created);
		const listed = value(await provider.list({ "agentrun.run": "run-1" }), "list");
		assert.deepEqual(listed.map((info) => info.ref), [created]);
		assert.equal(listed[0].state, "running");
		assert.deepEqual(listed[0].labels, { "agentrun.run": "run-1", job: "j-42" });
		assert.equal(listed[0].network, "open");
		assert.doesNotMatch(JSON.stringify([created, byId, byLabels, listed]), SECRET, "no URL in a ref, an attach or a list");
		const none = await provider.attach({ labels: { "agentrun.run": "no-such-run" } });
		assert.equal(none.ok, false);
		assert.equal(none.error.code, "not_found");
		assert.match(none.error.message, /no-such-run/);
		const empty = await provider.list({});
		assert.equal(empty.ok, false, "list by no label at all is refused: the vendor's account holds sessions no provider made");
		assert.equal(empty.error.code, "invalid");
	});

	test(`${id}: connect hands over the vendor's signed CDP URL, and a client that answers hello and ping from the vendor`, async () => {
		const fake = vendor.fake();
		const provider = await vendor.make(fake);
		const ref = value(await provider.create(spec()), "create");
		const connection = value(await provider.connect(ref), "connect");
		assert.match(connection.cdp.url, /^wss:\/\/.*SECRET/, "the vendor's own signed URL");
		assert.equal(fake.dialed.length, 0, "connect dials nothing: the URL is the driver's to dial");
		assert.deepEqual(connection.hello, { version: provider.version, os: "linux", kind: "browser", arch: "unknown", groups: vendor.capabilities.groups });
		assert.deepEqual(value(await connection.client.call("hello", { client: "test" }), "hello"), connection.hello);
		assert.deepEqual(value(await connection.client.call("ping", {}), "ping"), {});
		const exec = await connection.client.call("exec.run", { argv: ["true"], timeoutMs: 1000 });
		assert.equal(exec.ok, false);
		assert.equal(exec.error.code, "unsupported");
		assert.match(exec.error.message, /exec\.run.*CDP/);
		await connection.close();
		const stream = value(await provider.stream(ref), "stream");
		assert.match(stream.url, /^https:\/\/.*SECRET-live/, "the vendor's live view");
		const viewOnly = await provider.stream(ref, { viewOnly: true });
		assert.equal(viewOnly.ok, false, "the vendor's live view takes input: a view-only one is refused, never handed over as one");
		assert.equal(viewOnly.error.code, "unsupported");
	});

	test(`${id}: release is idempotent, and attach, connect and ping after it fail in words that carry no URL`, async () => {
		const fake = vendor.fake();
		const provider = await vendor.make(fake);
		const ref = value(await provider.create(spec()), "create");
		const { client } = value(await provider.connect(ref), "connect");
		value(await provider.release(ref, "delete"), "release");
		value(await provider.release(ref, "delete"), "a second release");
		value(await provider.release({ id: `${id}-never-made`, name: `${id}-never-made` }, "delete"), "release of one never made");
		const stop = await provider.release(ref, "stop");
		assert.equal(stop.ok, false, "a stop the provider does not declare is refused");
		const failures = [
			await provider.attach({ id: ref.id }),
			await provider.attach({ labels: { "agentrun.run": "run-1" } }),
			await provider.connect(ref),
			await client.call("ping", {}),
			await provider.stream(ref),
		];
		for (const failed of failures) {
			assert.equal(failed.ok, false, JSON.stringify(failed));
			assert.ok(["not_found", "gone"].includes(failed.error.code), failed.error.code);
			assert.ok(failed.error.message.length > 0);
			assert.doesNotMatch(failed.error.message, SECRET);
		}
		assert.deepEqual(value(await provider.list({ "agentrun.run": "run-1" }), "list"), []);
	});

	test(`${id}: check() refuses a lifetime past the vendor's cap, a closed network and a size, and create calls no vendor`, async () => {
		const fake = vendor.fake();
		const provider = await vendor.make(fake);
		const { maxLifetimeMs } = provider.capabilities();
		assert.deepEqual(provider.check(spec({ lifetimeMs: maxLifetimeMs })), []);
		const past = provider.check(spec({ lifetimeMs: maxLifetimeMs + 1 }));
		assert.equal(past.length, 1);
		assert.equal(past[0].field, "lifetimeMs");
		assert.match(past[0].message, /at most/);
		assert.equal(provider.check(spec({ network: "none" }))[0].field, "network");
		assert.equal(provider.check(spec({ image: "debian:bookworm-slim" }))[0].field, "image");
		assert.equal(provider.check(spec({ cpus: 2 }))[0].field, "cpus");
		const refused = await provider.create(spec({ lifetimeMs: maxLifetimeMs + 1 }));
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, "refused");
		assert.ok(refused.error.message.includes(past[0].message), "create's refusal carries check()'s words");
		assert.equal(vendor.creates(fake).length, 0, "no vendor call");
	});

	test(`${id}: testConnection is one account-level read that makes nothing; a refused key is unauthorized, its words hold no key`, async () => {
		const fake = vendor.fake();
		const provider = await vendor.make(fake);
		value(await provider.create(spec()), "a running session to count");
		const before = fake.calls.length;
		const tested = value(await provider.testConnection(), "testConnection");
		assert.match(tested.detail, /answered: 1 (running session|active browser)/);
		assert.equal(fake.calls.length - before, 1, "one read");
		assert.equal(fake.calls.at(-1).method, "GET", "a read, never a create");
		const wrong = await vendor.make(vendor.fake(), { apiKey: "not-the-key-SECRETKEY" });
		const refused = await wrong.testConnection();
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, "unauthorized");
		assert.doesNotMatch(refused.error.message, /SECRETKEY|ECHO/);
		const away = await vendor.make(vendor.fake(), { fetch: async () => { throw new TypeError("fetch failed"); } });
		const unreached = await away.testConnection();
		assert.equal(unreached.ok, false);
		assert.equal(unreached.error.code, "unreachable");
	});

	test(`${id}: a vendor failure is a result naming the call and the status, never the vendor's words`, async () => {
		const provider = await vendor.make(vendor.fake({ failCreate: 502 }));
		const failed = await provider.create(spec());
		assert.equal(failed.ok, false);
		assert.equal(failed.error.code, id);
		assert.match(failed.error.message, /POST .* answered 502/);
		assert.doesNotMatch(failed.error.message, new RegExp(ECHO));
		const wrongKey = await vendor.make(vendor.fake(), { apiKey: "not-the-key" });
		const denied = await wrongKey.create(spec());
		assert.equal(denied.error.code, "denied");
		assert.doesNotMatch(denied.error.message, /not-the-key/);
	});
}
