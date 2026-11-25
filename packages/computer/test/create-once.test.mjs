// Idempotent create (spec/computer/provider.md) on Orgo, Browserbase, Kernel and Local Chrome, over their fakes: one
// computer per request id, named for it (computerNameFor); the same id while it starts and once it is up answers that
// computer; another spec with the same id is refused exists; after release the id is refused exists; and a create of
// the same id from another provider instance (another process) finds the computer the first one made instead of making
// a second. Orgo also runs the conformance suite's two cases, provider.create-retried and provider.create-after-release.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { computerNameFor } from "../dist/provider.js";
import { BROWSERBASE_KEY, BROWSERBASE_URL, fakeBrowserbase, fakeKernel, KERNEL_KEY, KERNEL_URL } from "./fake-browser.mjs";
import { API, fakeOrgoApi, fakeOrgoChannel, KEY, WORKSPACE } from "./fake-orgo.mjs";

const scratch = mkdtempSync(join("/tmp", "once-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const DAEMON_PATH = join(scratch, "computerd");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
// The fake Chrome, which writes each profile it is started on to LAUNCHES: one line per Chrome a create started.
const CHROME = join(scratch, "chrome");
const LAUNCHES = join(scratch, "launches");
writeFileSync(LAUNCHES, "");
writeFileSync(CHROME, `#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) echo "\${a#--user-data-dir=}" >> "${LAUNCHES}";; esac; done\nexec "${process.execPath}" "${fileURLToPath(new URL("./fake-chrome.mjs", import.meta.url))}" "$@"\n`);
chmodSync(CHROME, 0o755);
const ORGO_TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 500, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5 };
const noSleep = async () => {};
let roots = 0;

const VENDORS = {
	orgo: {
		spec: (labels = {}) => ({ image: "linux", lifetimeMs: 30 * 60_000, network: "none", labels: { "agentrun.run": "run-once", "agentrun.epoch": "1", ...labels } }),
		vendor: () => ({ api: fakeOrgoApi(), channel: fakeOrgoChannel() }),
		async make({ api, channel }) {
			const { create } = await import("../dist/orgo.js");
			return create({ apiKey: KEY, workspaceId: WORKSPACE, apiUrl: API, fetch: api.fetch, channel, daemonPath: DAEMON_PATH, timeouts: ORGO_TIMEOUTS });
		},
		made: ({ api }) => api.requests.filter((r) => r.method === "POST" && r.path === "/computers").length,
		/** Orgo holds no labels: its name carries what list reads after the request's name (the run's hash, the epoch, the deadline). */
		named: (name, requestId) => name.startsWith(`${computerNameFor(requestId)}-`),
	},
	browserbase: {
		spec: (labels = {}) => ({ image: "chromium", lifetimeMs: 30 * 60_000, network: "open", labels: { "agentrun.run": "run-once", ...labels } }),
		vendor: () => fakeBrowserbase(),
		async make(fake) {
			const { BrowserbaseProvider } = await import("../dist/browserbase.js");
			return new BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: fake.fetch, sleep: noSleep });
		},
		made: (fake) => fake.only("POST", "/v1/sessions").length,
		/** A session has no name: the request's name is its create label, and the ref's name is the session's id. */
		named: (_name, requestId, fake, id) => fake.sessions.get(id).userMetadata.agentrun_create === computerNameFor(requestId),
	},
	kernel: {
		spec: (labels = {}) => ({ image: "chromium", lifetimeMs: 30 * 60_000, network: "open", labels: { "agentrun.run": "run-once", ...labels } }),
		vendor: () => fakeKernel(),
		async make(fake) {
			const { KernelProvider } = await import("../dist/kernel.js");
			return new KernelProvider({ apiKey: KERNEL_KEY, apiUrl: KERNEL_URL, fetch: fake.fetch, sleep: noSleep });
		},
		made: (fake) => fake.only("POST", "/browsers").length,
		named: (_name, requestId, fake, id) => fake.browsers.get(id).tags["agentrun.create"] === computerNameFor(requestId),
	},
	"local-chrome": {
		spec: (labels = {}) => ({ image: "chromium", lifetimeMs: 60_000, network: "open", labels: { "agentrun.run": "run-once", ...labels } }),
		/** The vendor is a root on this machine: two providers on one root are two processes on one machine. */
		vendor: () => ({ root: join(scratch, `r${++roots}`) }),
		async make({ root }) {
			const { LocalBrowserProvider } = await import("../dist/local-chrome.js");
			return new LocalBrowserProvider({ executablePath: CHROME, root, uid: process.getuid() });
		},
		made: ({ root }) => readFileSync(LAUNCHES, "utf8").split("\n").filter((line) => line.startsWith(`${root}/`)).length,
		named: (name, requestId) => name === computerNameFor(requestId),
	},
};

const refOf = ({ id, name }) => ({ id, name });
const okOf = (result, what) => {
	assert.equal(result.ok, true, `${what}: ${JSON.stringify(result.ok ? "" : result.error)}`);
	return result.value;
};
let requests = 0;
const requestOf = (id) => `create-once-${id}-${++requests}`;

for (const [id, vendor] of Object.entries(VENDORS)) {
	test(`${id}: a create retried while it starts and once it is up answers the computer the first made, named for its request`, async () => {
		const fake = vendor.vendor();
		const provider = await vendor.make(fake);
		const requestId = requestOf(id);
		const spec = vendor.spec();
		const [first, early] = await Promise.all([provider.create(spec, { requestId }), provider.create(spec, { requestId })]);
		const made = okOf(first, "create");
		assert.deepEqual(refOf(okOf(early, "the same create while the first starts")), refOf(made));
		assert.deepEqual(refOf(okOf(await provider.create(spec, { requestId }), "the same create once it is up")), refOf(made));
		assert.equal(vendor.made(fake), 1, "one computer for three creates of one request");
		assert.ok(vendor.named(made.name, requestId, fake, made.id), `${made.name} is named for its request ${computerNameFor(requestId)}`);
		okOf(await provider.release(made, "delete"), "release");
	});

	test(`${id}: the same request id with another spec is refused exists, in flight and once made, and makes nothing`, async () => {
		const fake = vendor.vendor();
		const provider = await vendor.make(fake);
		const requestId = requestOf(id);
		const [first, other] = await Promise.all([provider.create(vendor.spec(), { requestId }), provider.create(vendor.spec({ role: "other" }), { requestId })]);
		const made = okOf(first, "create");
		assert.equal(other.ok, false, "another spec while the first is in flight");
		assert.equal(other.error.code, "exists");
		assert.match(other.error.message, /is being made for this request with another spec/);
		const later = await provider.create(vendor.spec({ role: "other" }), { requestId });
		assert.equal(later.ok, false, "another spec once the first is up");
		assert.equal(later.error.code, "exists");
		assert.equal(vendor.made(fake), 1, "nothing more was made");
		okOf(await provider.release(made, "delete"), "release");
	});

	test(`${id}: after its computer is released, the same request id is refused exists in words and makes nothing`, async () => {
		const fake = vendor.vendor();
		const provider = await vendor.make(fake);
		const requestId = requestOf(id);
		const made = okOf(await provider.create(vendor.spec(), { requestId }), "create");
		okOf(await provider.release(made, "delete"), "release");
		const again = await provider.create(vendor.spec(), { requestId });
		assert.equal(again.ok, false, "the same id after release");
		assert.equal(again.error.code, "exists");
		assert.match(again.error.message, /was made for this request and has ended: create with a new request id/);
		assert.equal(vendor.made(fake), 1, "nothing more was made");
	});

	test(`${id}: a create of the same request from another provider instance finds the computer the first made`, async () => {
		const fake = vendor.vendor();
		const [one, two] = [await vendor.make(fake), await vendor.make(fake)];
		const requestId = requestOf(id);
		const made = okOf(await one.create(vendor.spec(), { requestId }), "create");
		assert.deepEqual(refOf(okOf(await two.create(vendor.spec(), { requestId }), "the same create from another instance")), refOf(made));
		assert.equal(vendor.made(fake), 1, "one computer for the request across both instances");
		const other = await two.create(vendor.spec({ role: "other" }), { requestId });
		assert.equal(other.ok, false, "another spec from another instance");
		assert.equal(other.error.code, "exists");
		assert.match(other.error.message, /was made for this request with another spec/);
		okOf(await one.release(made, "delete"), "release");
	});
}

test("orgo: the conformance suite's provider.create-retried and provider.create-after-release pass on the fake", async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const cases = conformanceCases.filter(({ id }) => ["provider.create-retried", "provider.create-after-release"].includes(id));
	assert.equal(cases.length, 2);
	const provider = await VENDORS.orgo.make(VENDORS.orgo.vendor());
	const report = await runConformance(provider, { image: "linux", cases, patience: 5_000, caseTimeoutMs: 60_000 });
	const statuses = Object.fromEntries(report.results.map(({ id, status, reason }) => [id, status === "pass" ? status : `${status}: ${reason}`]));
	assert.deepEqual(statuses, { "provider.create-retried": "pass", "provider.create-after-release": "pass" });
	assert.deepEqual(report.cleanup.left, []);
});

/** Holds Orgo's POST /computers until `count` creates have asked, then lets them land in the order they asked. */
const postsTogether = (count) => {
	const waiting = [];
	return ({ method, path }) => {
		if (method !== "POST" || path !== "/computers" || waiting.length >= count) return undefined;
		return new Promise((resolve) => {
			waiting.push(resolve);
			if (waiting.length === count) for (const go of waiting) go();
		});
	};
};

/** The computers Orgo still holds for a request, and the ones deleted. */
const orgoHeld = (api, requestId) => {
	const mine = [...api.computers.values()].filter((record) => record.name.startsWith(`${computerNameFor(requestId)}-`));
	return { live: mine.filter((record) => !record.deleted), deleted: mine.filter((record) => record.deleted) };
};

test("orgo: two provider instances whose creates of one request both find nothing and both make a computer answer one, the older, and delete the newer", async () => {
	const api = fakeOrgoApi({ hold: postsTogether(2) });
	const channel = fakeOrgoChannel();
	const [one, two] = [await VENDORS.orgo.make({ api, channel }), await VENDORS.orgo.make({ api, channel })];
	const requestId = requestOf("orgo-both");
	const spec = VENDORS.orgo.spec();
	const first = one.create(spec, { requestId });
	// The second starts in a later second, so its name, whose deadline is in whole seconds, is not the first's: Orgo
	// takes both creates, and neither finds the other's computer before it makes its own.
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	const second = two.create(spec, { requestId });
	const [a, b] = await Promise.all([first, second]);
	const kept = okOf(a, "the first create");
	assert.deepEqual(refOf(okOf(b, "the second create")), refOf(kept), "both answer one computer");
	assert.equal(VENDORS.orgo.made({ api }), 2, "both made one");
	const { live, deleted } = orgoHeld(api, requestId);
	assert.deepEqual(live.map((record) => record.id), [kept.id], "Orgo holds the older alone");
	const [older, newer] = [...api.computers.values()].filter((record) => record.name.startsWith(`${computerNameFor(requestId)}-`));
	assert.equal(kept.id, older.id, "the computer answered is the older, the first one Orgo made");
	assert.deepEqual(deleted.map((record) => record.id), [newer.id], "the newer is deleted");
	assert.deepEqual(channel.calls.filter((call) => call.computer === newer.id), [], "the newer is deleted before anything is uploaded or run in it");
	okOf(await one.release(kept, "delete"), "release");
});

test("orgo: two provider instances whose creates of one request start together answer one computer", async () => {
	const api = fakeOrgoApi({ hold: postsTogether(2) });
	const channel = fakeOrgoChannel();
	const [one, two] = [await VENDORS.orgo.make({ api, channel }), await VENDORS.orgo.make({ api, channel })];
	const requestId = requestOf("orgo-together");
	const spec = VENDORS.orgo.spec();
	// Most often both names are one (Orgo refuses the second's: name in use); across a second's edge they differ.
	const [a, b] = await Promise.all([one.create(spec, { requestId }), two.create(spec, { requestId })]);
	const kept = okOf(a, "the first create");
	assert.deepEqual(refOf(okOf(b, "the second create")), refOf(kept), "both answer one computer");
	assert.deepEqual(orgoHeld(api, requestId).live.map((record) => record.id), [kept.id], "Orgo holds one computer for the request");
	okOf(await one.release(kept, "delete"), "release");
});

/** The two browser vendors, as the tests of two processes on one vendor read them. */
const CLOUD_BROWSERS = {
	browserbase: {
		post: "/v1/sessions",
		/** Every session the fake made, in the order it made them. */
		ids: (fake) => [...fake.sessions.keys()],
		live: (fake, id) => fake.sessions.get(id).status === "RUNNING",
		/** Ends a session as Browserbase does at its timeout. */
		expire: (fake, id) => {
			fake.sessions.get(id).status = "COMPLETED";
		},
	},
	kernel: {
		post: "/browsers",
		ids: (fake) => [...fake.browsers.keys()],
		live: (fake, id) => fake.browsers.get(id).deletedAt === undefined,
		expire: (fake, id) => {
			fake.browsers.get(id).deletedAt = new Date().toISOString();
		},
	},
};

/** A vendor's fetch whose creates (POST to `post`) wait until `count` have asked, then go on in the order they asked. */
const createsTogether = (fetch, post, count) => {
	const waiting = [];
	return async (input, init = {}) => {
		if ((init.method ?? "GET") === "POST" && new URL(String(input)).pathname === post && waiting.length < count) {
			await new Promise((resolve) => {
				waiting.push(resolve);
				if (waiting.length === count) for (const go of waiting) go();
			});
		}
		return fetch(input, init);
	};
};

for (const [id, cloud] of Object.entries(CLOUD_BROWSERS)) {
	const vendor = VENDORS[id];

	test(`${id}: two provider instances whose creates of one request both find nothing and both make a browser answer one, the older, and release the newer`, async () => {
		const fake = vendor.vendor();
		const shared = { ...fake, fetch: createsTogether(fake.fetch, cloud.post, 2) };
		const [one, two] = [await vendor.make(shared), await vendor.make(shared)];
		const requestId = requestOf(`${id}-both`);
		const [a, b] = await Promise.all([one.create(vendor.spec(), { requestId }), two.create(vendor.spec(), { requestId })]);
		const kept = okOf(a, "the first create");
		assert.deepEqual(refOf(okOf(b, "the second create")), refOf(kept), "both answer one browser");
		assert.equal(vendor.made(fake), 2, "both made one");
		const [older, newer] = cloud.ids(fake);
		assert.equal(kept.id, older, "the browser answered is the older, the first the vendor made");
		assert.equal(cloud.live(fake, older), true, "the older runs");
		assert.equal(cloud.live(fake, newer), false, "the newer is released");
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a create whose reply is lost releases the browser its own POST made, never the one another instance answered for the request`, async () => {
		const fake = vendor.vendor();
		const requestId = requestOf(`${id}-lost`);
		const gate = () => {
			let open;
			const opened = new Promise((resolve) => (open = resolve));
			return { open, opened };
		};
		// A's create is held until B has looked for the request's browser (and found none); B's until A's is answered.
		const looked = gate();
		const answered = gate();
		const isPost = (input, init) => (init.method ?? "GET") === "POST" && new URL(String(input)).pathname === cloud.post;
		const fetchA = async (input, init = {}) => {
			if (isPost(input, init)) await looked.opened;
			return fake.fetch(input, init);
		};
		const fetchB = async (input, init = {}) => {
			if (isPost(input, init)) {
				await answered.opened;
				await fake.fetch(input, init);
				// The vendor made B's browser, and its reply never comes.
				throw new TypeError("fetch failed");
			}
			const answer = await fake.fetch(input, init);
			if ((init.method ?? "GET") === "GET" && new URL(String(input)).pathname === cloud.post) setTimeout(looked.open, 10);
			return answer;
		};
		const one = await vendor.make({ ...fake, fetch: fetchA });
		const two = await vendor.make({ ...fake, fetch: fetchB });
		const first = one.create(vendor.spec(), { requestId }).then((result) => {
			answered.open();
			return result;
		});
		const [a, b] = await Promise.all([first, two.create(vendor.spec(), { requestId })]);
		const kept = okOf(a, "A's create");
		assert.equal(b.ok, false, "B's create, its reply lost");
		const [mine, theirs] = cloud.ids(fake);
		assert.equal(kept.id, mine);
		assert.equal(cloud.live(fake, mine), true, "the browser A answered still runs");
		assert.equal(cloud.live(fake, theirs), false, "the browser B's lost create made is released");
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a create whose browser is the newer, the older ended before it is answered, releases its own and is refused exists`, async () => {
		const fake = vendor.vendor();
		const requestId = requestOf(`${id}-gone`);
		// The other instance's browser is listed when this create looks again, and ended before it is answered.
		let ended = false;
		const shared = {
			...fake,
			fetch: createsTogether(async (input, init = {}) => {
				const answer = await fake.fetch(input, init);
				// The newer's release (Browserbase's POST, Kernel's DELETE, on the browser's own path) ends the older.
				if (!ended && (init.method ?? "GET") !== "GET" && /\/(sessions|browsers)\/[^/]+$/.test(new URL(String(input)).pathname)) {
					ended = true;
					cloud.expire(fake, cloud.ids(fake)[0]);
				}
				return answer;
			}, cloud.post, 2),
		};
		const [one, two] = [await vendor.make(shared), await vendor.make(shared)];
		const [, b] = await Promise.all([one.create(vendor.spec(), { requestId }), two.create(vendor.spec(), { requestId })]);
		assert.equal(b.ok, false, "the newer's create, the older gone");
		assert.equal(b.error.code, "exists");
		assert.match(b.error.message, /was made for this request and has ended: create with a new request id/);
		assert.equal(cloud.live(fake, cloud.ids(fake)[1]), false, "the newer is released");
	});
}

/** How each provider's browser ends on its own, with no release: the vendor ends it, or the deadline does. */
const ENDS = {
	browserbase: { spec: () => VENDORS.browserbase.spec(), end: (fake, ref) => CLOUD_BROWSERS.browserbase.expire(fake, ref.id) },
	kernel: { spec: () => VENDORS.kernel.spec(), end: (fake, ref) => CLOUD_BROWSERS.kernel.expire(fake, ref.id) },
	"local-chrome": {
		spec: () => ({ ...VENDORS["local-chrome"].spec(), lifetimeMs: 1_500 }),
		// The supervisor ends Chrome at the deadline and removes the browser's directory.
		end: async ({ root }, ref) => {
			for (const until = Date.now() + 15_000; existsSync(join(root, ref.id)); ) {
				assert.ok(Date.now() < until, "the deadline removes the browser's directory");
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		},
	},
};

for (const [id, ends] of Object.entries(ENDS)) {
	const vendor = VENDORS[id];
	test(`${id}: a browser that ended on its own, with no release, leaves its request refused exists, as a release does`, async () => {
		const fake = vendor.vendor();
		const provider = await vendor.make(fake);
		const requestId = requestOf(`${id}-ended`);
		const made = okOf(await provider.create(ends.spec(), { requestId }), "create");
		await ends.end(fake, made);
		const again = await provider.create(ends.spec(), { requestId });
		assert.equal(again.ok, false, "the same id once its browser ended");
		assert.equal(again.error.code, "exists");
		assert.match(again.error.message, /was made for this request and has ended: create with a new request id/);
		assert.equal(vendor.made(fake), 1, "nothing more was made");
	});
}

test("a create with no request id is refused invalid on each, before any vendor call", async () => {
	for (const [id, vendor] of Object.entries(VENDORS)) {
		const fake = vendor.vendor();
		const provider = await vendor.make(fake);
		const refused = await provider.create(vendor.spec(), {});
		assert.equal(refused.ok, false, id);
		assert.equal(refused.error.code, "invalid", id);
		assert.match(refused.error.message, /create needs context\.requestId/, id);
		assert.equal(vendor.made(fake), 0, id);
	}
});
