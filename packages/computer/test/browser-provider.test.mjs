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
		/** Browserbase refuses a dot in a metadata key, so a label's dots are written as underscores. */
		heldLabels: { agentrun_run: "run-1", job: "j-42" },
		lifetime: (fake, id) => fake.sessions.get(id).expiresAt,
		creates: (fake) => fake.only("POST", "/v1/sessions"),
		/** The domain its CDP URL is on, as read live on 11-08. */
		domain: "browserbase.com",
		/** A fake vendor whose create answers this CDP URL (undefined: none). */
		answering: (url) => fakeBrowserbase({ connectUrl: () => url }),
		/** Sets the CDP URL the vendor holds for a session, as a later read gives it. */
		holds: (fake, id, url) => {
			fake.sessions.get(id).connectUrl = url;
		},
		/** Whether every session the fake made was released. */
		allReleased: (fake) => [...fake.sessions.values()].every((s) => s.status !== "RUNNING"),
		/** Whether the fake still runs this session. */
		running: (fake, id) => fake.sessions.get(id).status === "RUNNING",
		/** The label query each list read asked by: Browserbase's q, a metadata key as list writes it (dots as "_"). */
		asked: (fake) => fake.only("GET", "/v1/sessions").map((call) => call.query.q),
		/** The query a list by this label asks, as list() asks it. */
		query: (key, value) => `user_metadata['${key.replaceAll(".", "_")}']:'${value}'`,
		/** The create label's value a create wrote. */
		createdBy: (call) => call.body.userMetadata.agentrun_create,
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
		heldLabels: { "agentrun.run": "run-1", job: "j-42" },
		lifetime: (fake, id) => fake.browsers.get(id).timeout,
		creates: (fake) => fake.only("POST", "/browsers"),
		domain: "kernel.sh",
		answering: (url) => fakeKernel({ cdpUrl: () => url }),
		holds: (fake, id, url) => {
			fake.browsers.get(id).cdp = url;
		},
		allReleased: (fake) => [...fake.browsers.values()].every((b) => b.deletedAt !== undefined),
		running: (fake, id) => fake.browsers.get(id).deletedAt === undefined,
		/** The tag filter each list read asked by. */
		asked: (fake) => fake.only("GET", "/browsers").map((call) => Object.entries(call.query).filter(([key]) => key.startsWith("tags[")).map(([key, v]) => `${key}=${v}`).join("&")),
		query: (key, value) => `tags[${key}]=${value}`,
		createdBy: (call) => call.body.tags["agentrun.create"],
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
		const { agentrun_create: byMetadata, "agentrun.create": byTags, ...held } = vendor.held(fake, created.id);
		assert.deepEqual(held, vendor.heldLabels, "the labels, as the vendor holds them");
		assert.match(byMetadata ?? byTags, /^[0-9a-f]{16}$/, "beside them, the create label: a value of this create's own");
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

	test(`${id}: connect reads the browser before it hands over a held CDP URL: one released elsewhere is gone, in words with no URL`, async () => {
		const fake = vendor.fake();
		const holder = await vendor.make(fake);
		const ref = value(await holder.create(spec()), "create");
		// Another instance of the provider (its own URL cache) ends the browser; the holder still has its URL.
		value(await (await vendor.make(fake)).release(ref, "delete"), "release through another instance");
		const connected = await holder.connect(ref);
		assert.equal(connected.ok, false, "a browser that is gone is not handed over");
		assert.equal(connected.error.code, "gone", connected.error.message);
		assert.ok(connected.error.message.includes(ref.id), connected.error.message);
		assert.doesNotMatch(JSON.stringify(connected), SECRET);
		// A browser the vendor never had is not_found, as before.
		const never = await holder.connect({ id: `${ref.id}0`, name: `${ref.id}0` });
		assert.equal(never.ok, false);
		assert.equal(never.error.code, "not_found", never.error.message);
	});

	test(`${id}: the check behind a held CDP URL never puts the URL in its words: gone, or a vendor read that failed, which keeps the URL held`, async () => {
		let failReads = false;
		const fake = vendor.fake();
		// A vendor whose read of one browser answers 500 while failReads is set.
		const fetch = async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input.url);
			if (failReads && (init?.method ?? "GET") === "GET" && /^\/(v1\/sessions|browsers)\/[^/]+$/.test(url.pathname)) return new Response(JSON.stringify({ error: "down" }), { status: 500 });
			return fake.fetch(input, init);
		};
		const provider = await vendor.make(fake, { fetch });
		const ref = value(await provider.create(spec()), "create");
		const held = value(await provider.connect(ref), "connect").cdp.url;
		assert.match(held, SECRET, "the fake's URL carries its signing secret");
		failReads = true;
		const failed = await provider.connect(ref);
		assert.equal(failed.ok, false, "a browser not read is not handed over");
		assert.ok(!["gone", "not_found"].includes(failed.error.code), `a vendor that did not answer is not a browser gone: ${failed.error.code}`);
		for (const words of [failed.error.message, JSON.stringify(failed)]) {
			assert.ok(!words.includes(held), "the held URL is not in the failure");
			assert.doesNotMatch(words, /wss:|SECRET/);
		}
		failReads = false;
		assert.equal(value(await provider.connect(ref), "connect once the vendor answers").cdp.url, held, "the held URL was kept");
		value(await (await vendor.make(fake)).release(ref, "delete"), "release through another instance");
		const gone = await provider.connect(ref);
		assert.equal(gone.error.code, "gone");
		for (const words of [gone.error.message, JSON.stringify(gone)]) {
			assert.ok(!words.includes(held), "the held URL is not in the gone");
			assert.doesNotMatch(words, /wss:|SECRET/);
		}
	});

	test(`${id}: a lost create is looked for by the labels it was made with, through list's own label query, and another browser of the same run is left running`, async () => {
		const knobs = {};
		const fake = vendor.fake(knobs);
		const provider = await vendor.make(fake);
		const sibling = value(await provider.create(spec()), "a browser of the same run");
		const before = vendor.asked(fake).length;
		knobs.loseCreate = () => undefined;
		const lost = await provider.create(spec());
		assert.equal(lost.ok, false);
		assert.match(lost.error.message, /released/, lost.error.message);
		assert.ok(vendor.running(fake, sibling.id), "the run's other browser, which carries the same run labels, still runs");
		const createdBy = vendor.createdBy(vendor.creates(fake)[1]);
		const asked = vendor.asked(fake).slice(before);
		assert.ok(asked.length > 0, "the lost create was looked for");
		assert.ok(asked.every((q) => q === vendor.query("agentrun.create", createdBy)), `each read asks by the create label as list() maps a label key: ${asked.join(", ")}`);
		assert.deepEqual(value(await provider.list({ "agentrun.run": "run-1" }), "list").map((info) => info.ref.id), [sibling.id]);
	});

	/** CDP URLs a driver must never be handed: none, not wss:, or not on the vendor's own domain. */
	const unusable = (domain) => [
		undefined,
		"",
		"not a url SECRET",
		`ws://cdp.${domain}/x?k=SECRET`,
		`https://cdp.${domain}/x?k=SECRET`,
		"wss://evil.example/x?k=SECRET",
		`wss://${domain}.evil.example/x?k=SECRET`,
		`wss://evil${domain}/x?k=SECRET`,
	];

	test(`${id}: a create answered with no usable CDP URL fails, and the session it made is released; the words say so and carry no URL`, async () => {
		for (const url of unusable(vendor.domain)) {
			const fake = vendor.answering(url);
			const provider = await vendor.make(fake);
			const made = await provider.create(spec());
			assert.equal(made.ok, false, `${JSON.stringify(url)}: create fails`);
			assert.equal(vendor.creates(fake).length, 1, "one create");
			assert.ok(vendor.allReleased(fake), `${JSON.stringify(url)}: the paid session it made is released, not left to its timeout`);
			assert.match(made.error.message, /released/, made.error.message);
			assert.doesNotMatch(JSON.stringify(made), SECRET);
		}
	});

	test(`${id}: a create whose reply is lost, or whose caller cancels it, finds the browser it made by its create label and releases it`, async () => {
		for (const cancel of [false, true]) {
			const controller = new AbortController();
			const fake = vendor.fake({ loseCreate: () => (cancel ? controller.abort() : undefined) });
			const provider = await vendor.make(fake);
			const made = await provider.create(spec(), { signal: controller.signal });
			const what = cancel ? "a cancelled create" : "a create whose reply was lost";
			assert.equal(made.ok, false, what);
			if (cancel) assert.equal(made.error.code, "aborted", made.error.message);
			assert.equal(vendor.creates(fake).length, 1, `${what}: one create, never a second`);
			assert.ok(vendor.allReleased(fake), `${what}: the browser it made is released, not left billing to its timeout`);
			assert.match(made.error.message, /released/, made.error.message);
			assert.doesNotMatch(JSON.stringify(made), SECRET);
			// The create label each create carries is the provider's own: no list or attach shows it.
			const { body } = vendor.creates(fake)[0];
			assert.equal(Object.keys(body.userMetadata ?? body.tags).length, 3, "the spec's two labels and the create label");
		}
		// A create the vendor refused (a 4xx) made nothing: nothing is looked for.
		const refused = vendor.fake({ failCreate: 422 });
		const failed = await (await vendor.make(refused)).create(spec());
		assert.equal(failed.ok, false);
		assert.equal(refused.calls.filter((c) => c.method === "GET").length, 0, "no search after a refusal");
	});

	test(`${id}: the create label is the provider's own: check() refuses it in a spec, and list and attach never show it`, async () => {
		const fake = vendor.fake();
		const provider = await vendor.make(fake);
		assert.ok(provider.check(spec({ labels: { "agentrun.create": "mine" } })).some((r) => r.field === "labels" && /agentrun\.create/.test(r.message)));
		const ref = value(await provider.create(spec()), "create");
		const [info] = value(await provider.list({ "agentrun.run": "run-1" }), "list");
		assert.deepEqual(info.labels, { "agentrun.run": "run-1", job: "j-42" });
		assert.equal(info.ref.id, ref.id);
	});

	test(`${id}: connect hands over a CDP URL only when it is wss: on the vendor's own domain; one the vendor reads back otherwise is refused in words with no URL`, async () => {
		for (const url of unusable(vendor.domain).filter((u) => u !== undefined && u !== "")) {
			const fake = vendor.fake();
			const ref = value(await (await vendor.make(fake)).create(spec()), "create");
			vendor.holds(fake, ref.id, url);
			// A provider with nothing held reads the URL from the vendor.
			const connected = await (await vendor.make(fake)).connect(ref);
			assert.equal(connected.ok, false, `${JSON.stringify(url)}: connect refuses it`);
			assert.doesNotMatch(JSON.stringify(connected), SECRET);
			assert.ok(connected.error.message.includes(`wss: on ${vendor.domain}`), connected.error.message);
		}
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

test("kernel: a lost create whose browser is still starting, which status=active does not list, is found by every state not deleted and released", async () => {
	const knobs = {};
	const fake = fakeKernel(knobs);
	// The browser is made, its reply lost, and it is still starting when the provider looks for it.
	knobs.loseCreate = (bid) => {
		fake.browsers.get(bid).starting = true;
	};
	const provider = await VENDORS.kernel.make(fake);
	const lost = await provider.create(spec());
	assert.equal(lost.ok, false);
	const [made] = [...fake.browsers.values()];
	assert.equal(made.deletedAt !== undefined, true, `the starting browser is released, not left billing: ${lost.error.message}`);
	assert.match(lost.error.message, /released/);
	const statuses = fake.only("GET", "/browsers").map((call) => call.query.status);
	assert.ok(statuses.length > 0 && statuses.every((s) => s === "all"), `the recovery reads every state, and keeps those not deleted: ${statuses.join(", ")}`);
});

test("kernel: list and attach by labels show a browser still starting, as Browserbase lists a PENDING session; a deleted one never", async () => {
	const fake = fakeKernel();
	const provider = await VENDORS.kernel.make(fake);
	const starting = value(await provider.create(spec()), "create");
	fake.browsers.get(starting.id).starting = true;
	const gone = value(await provider.create(spec({ labels: { "agentrun.run": "run-1", job: "j-43" } })), "create");
	value(await provider.release(gone, "delete"), "release");
	assert.deepEqual(value(await provider.list({ "agentrun.run": "run-1" }), "list").map((info) => info.ref.id), [starting.id]);
	assert.equal(value(await provider.attach({ labels: { job: "j-42" } }), "attach by labels").id, starting.id);
	const statuses = fake.only("GET", "/browsers").map((call) => call.query.status);
	assert.ok(statuses.every((s) => s === "all"), `list reads every state and keeps those not deleted: ${statuses.join(", ")}`);
});

test("browserbase: a label's dots ride as underscores in userMetadata, which Browserbase refuses a dot in; list and attach read them back as labels", async () => {
	const fake = fakeBrowserbase();
	const provider = await VENDORS.browserbase.make(fake);
	const labels = { "agentrun.conformance": "abc123", "agentrun.conformance.case": "labels", job: "j-42" };
	const created = value(await provider.create(spec({ labels })), "create with dotted label keys");
	const { agentrun_create: _, ...held } = fake.sessions.get(created.id).userMetadata;
	assert.deepEqual(held, { agentrun_conformance: "abc123", agentrun_conformance_case: "labels", job: "j-42" });
	const listed = value(await provider.list({ "agentrun.conformance": "abc123" }), "list by a dotted label");
	assert.deepEqual(listed.map((info) => info.ref), [created]);
	assert.deepEqual(listed[0].labels, labels, "the labels read back as they were given");
	const asked = fake.only("GET", "/v1/sessions").map((call) => call.query.q);
	assert.ok(asked.every((q) => q === "user_metadata['agentrun_conformance']:'abc123'"), `the query names the metadata key: ${asked.join(", ")}`);
	assert.deepEqual({ ...value(await provider.attach({ labels: { "agentrun.conformance.case": "labels" } }), "attach by a dotted label") }.id, created.id);
});

test("browserbase: check() refuses, by name, a label key an underscore or another character would make ambiguous, and a value that would break the query's quotes", async () => {
	const fake = fakeBrowserbase();
	const provider = await VENDORS.browserbase.make(fake);
	for (const key of ["agentrun_tag", "a b", "a-b", "a:b", "a/b"]) {
		const refusals = provider.check(spec({ labels: { [key]: "x" } }));
		assert.equal(refusals.length, 1, `${key}: ${JSON.stringify(refusals)}`);
		assert.equal(refusals[0].field, "labels");
		assert.ok(refusals[0].message.includes(JSON.stringify(key)), `${key}: the refusal names the key: ${refusals[0].message}`);
	}
	for (const bad of ["it's", "a\\b"]) {
		const refusals = provider.check(spec({ labels: { job: bad } }));
		assert.equal(refusals.length, 1, `${bad}: ${JSON.stringify(refusals)}`);
		assert.equal(refusals[0].field, "labels");
		assert.match(refusals[0].message, /job/);
	}
	assert.deepEqual(provider.check(spec({ labels: { "agentrun.run": "run-1", Job2: "j-42" } })), []);
	const refused = await provider.list({ agentrun_tag: "x" });
	assert.equal(refused.ok, false, "list refuses such a key too");
	assert.equal(refused.error.code, "invalid");
	assert.equal(fake.calls.length, 0, "no vendor call");
});
