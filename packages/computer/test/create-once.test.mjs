// Idempotent create (spec/computer/provider.md) on Orgo, Browserbase, Kernel and Local Chrome, over their fakes: one
// computer per request id, named for it (computerNameFor); the same id while it starts and once it is up answers that
// computer; another spec with the same id is refused exists; after release the id is refused exists; and a create of
// the same id from another provider instance (another process) finds the computer the first one made instead of making
// a second. Orgo also runs the conformance suite's two cases, provider.create-retried and provider.create-after-release.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
		async make(fake, options = {}) {
			const { BrowserbaseProvider } = await import("../dist/browserbase.js");
			return new BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: fake.fetch, sleep: noSleep, ...options });
		},
		made: (fake) => fake.only("POST", "/v1/sessions").length,
		/** A session has no name: the request's name is its create label, and the ref's name is the session's id. */
		named: (_name, requestId, fake, id) => fake.sessions.get(id).userMetadata.agentrun_create === computerNameFor(requestId),
	},
	kernel: {
		spec: (labels = {}) => ({ image: "chromium", lifetimeMs: 30 * 60_000, network: "open", labels: { "agentrun.run": "run-once", ...labels } }),
		vendor: () => fakeKernel(),
		async make(fake, options = {}) {
			const { KernelProvider } = await import("../dist/kernel.js");
			return new KernelProvider({ apiKey: KERNEL_KEY, apiUrl: KERNEL_URL, fetch: fake.fetch, sleep: noSleep, ...options });
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
		/** The release calls the vendor was asked for one session: POST /v1/sessions/{id}. */
		releases: (fake, id) => fake.only("POST", `/v1/sessions/${id}`).length,
		/** A vendor whose sessions' CDP URL is on another host, one no driver is handed. */
		unusable: () => fakeBrowserbase({ connectUrl: () => "wss://elsewhere.test/cdp" }),
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
		/** The release calls the vendor was asked for one browser: DELETE /browsers/{id}. */
		releases: (fake, id) => fake.only("DELETE", `/browsers/${id}`).length,
		unusable: () => fakeKernel({ cdpUrl: () => "wss://elsewhere.test/cdp" }),
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

	test(`${id}: a create whose reply is lost leaves the browser its POST made when it is the request's older one, which another instance's converge answered`, async () => {
		const fake = vendor.vendor();
		const requestId = requestOf(`${id}-lost-older`);
		const gate = () => {
			let open;
			const opened = new Promise((resolve) => (open = resolve));
			return { open, opened };
		};
		// A looks for the request's browser first (none), then B's POST makes the older browser, then A's POST the newer;
		// B's reply is lost, and its recovery runs once A's converge has answered B's browser.
		const looked = gate();
		const madeB = gate();
		const answered = gate();
		const isPost = (input, init) => (init.method ?? "GET") === "POST" && new URL(String(input)).pathname === cloud.post;
		const isList = (input, init) => (init.method ?? "GET") === "GET" && new URL(String(input)).pathname === cloud.post;
		let listsA = 0;
		const fetchA = async (input, init = {}) => {
			if (isPost(input, init)) await madeB.opened;
			const answer = await fake.fetch(input, init);
			if (isList(input, init) && ++listsA === 1) looked.open();
			return answer;
		};
		const fetchB = async (input, init = {}) => {
			if (isPost(input, init)) {
				await looked.opened;
				await fake.fetch(input, init);
				madeB.open();
				await answered.opened;
				// The vendor made B's browser, and its reply never comes.
				throw new TypeError("fetch failed");
			}
			return fake.fetch(input, init);
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
		const [older, newer] = cloud.ids(fake);
		assert.equal(kept.id, older, "A's converge answers B's browser, the older");
		assert.equal(cloud.live(fake, newer), false, "A's own browser, the newer, is released");
		assert.equal(cloud.live(fake, older), true, "the browser A answered still runs after B's recovery");
		assert.match(b.error.message, /left running/);
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

test("local-chrome: a directory an earlier create claimed and never finished is refused exists once its claim's process is gone or it is past a create's time, never waited on", async () => {
	const vendor = VENDORS["local-chrome"];
	const fake = vendor.vendor();
	const provider = await vendor.make(fake);
	mkdirSync(fake.root, { recursive: true, mode: 0o700 });
	// A process that has ended: the pid of a create that crashed after its mkdir.
	const gone = spawnSync(process.execPath, ["-e", ""]).pid;
	const crashed = [
		["its claim names a process that is gone", (dir) => writeFileSync(join(dir, "claim.json"), JSON.stringify({ pid: gone, at: new Date().toISOString() }))],
		["it holds no claim, and is older than a create's time", (dir) => {
			const old = new Date(Date.now() - 60 * 60_000);
			utimesSync(dir, old, old);
		}],
		["its claim's process runs, and the claim is older than a create's time", (dir) => writeFileSync(join(dir, "claim.json"), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 60 * 60_000).toISOString() }))],
	];
	for (const [what, leave] of crashed) {
		const requestId = requestOf("local-claim");
		const dir = join(fake.root, computerNameFor(requestId));
		mkdirSync(dir, { mode: 0o700 });
		leave(dir);
		const started = Date.now();
		const again = await provider.create(vendor.spec(), { requestId });
		assert.equal(again.ok, false, what);
		assert.equal(again.error.code, "exists", `${what}: ${again.error.message}`);
		assert.match(again.error.message, /an earlier create of this request did not finish: create with a new request id/, what);
		assert.ok(Date.now() - started < 5_000, `${what}: refused at once, not after a create's wait`);
	}
	assert.equal(vendor.made(fake), 0, "no Chrome was started");
	// A create's own claim: its process and the time, written in the directory it made.
	const made = okOf(await provider.create(vendor.spec(), { requestId: requestOf("local-claim") }), "create");
	const claim = JSON.parse(readFileSync(join(fake.root, made.id, "claim.json"), "utf8"));
	assert.equal(claim.pid, process.pid, "the claim names the process that made the directory");
	assert.ok(Math.abs(Date.now() - Date.parse(claim.at)) < 60_000, "and when");
	okOf(await provider.release(made, "delete"), "release");
});

/**
 * A vendor's fetch that aborts the caller's create (controller) as the `nth` listing (a GET of `listed`) after its POST
 * is asked: the listing a create runs once the vendor made its computer.
 */
const abortingListing = (fetch, post, listed, nth, controller) => {
	let posted = false;
	let lists = 0;
	return async (input, init = {}) => {
		const method = init.method ?? "GET";
		const path = new URL(String(input)).pathname;
		if (method === "POST" && path.endsWith(post)) posted = true;
		else if (posted && method === "GET" && path.endsWith(listed) && ++lists === nth) controller.abort();
		return fetch(input, init);
	};
};

for (const [id, cloud] of Object.entries(CLOUD_BROWSERS)) {
	const vendor = VENDORS[id];
	test(`${id}: a create aborted while it lists the request's browsers after its POST is aborted, and the browser its POST made is released`, async () => {
		const fake = vendor.vendor();
		const controller = new AbortController();
		const provider = await vendor.make({ ...fake, fetch: abortingListing(fake.fetch, cloud.post, cloud.post, 1, controller) });
		const made = await provider.create(vendor.spec(), { requestId: requestOf(`${id}-aborted`), signal: controller.signal });
		assert.equal(made.ok, false, "an aborted create");
		assert.equal(made.error.code, "aborted", made.error.message);
		assert.equal(vendor.made(fake), 1, "its POST made one");
		assert.deepEqual(cloud.ids(fake).filter((one) => cloud.live(fake, one)), [], "none is left running");
	});
}

for (const [nth, when] of [
	[1, "after Orgo's answer"],
	[2, "once its computer is up"],
]) {
	test(`orgo: a create aborted while it reads the workspace ${when} is aborted, and the computer it made is deleted`, async () => {
		const { api, channel } = VENDORS.orgo.vendor();
		const controller = new AbortController();
		const provider = await VENDORS.orgo.make({ api: { ...api, fetch: abortingListing(api.fetch, "/computers", `/workspaces/${WORKSPACE}`, nth, controller) }, channel });
		const requestId = requestOf("orgo-aborted");
		const made = await provider.create(VENDORS.orgo.spec(), { requestId, signal: controller.signal });
		assert.equal(made.ok, false, "an aborted create");
		assert.equal(made.error.code, "aborted", made.error.message);
		assert.equal(VENDORS.orgo.made({ api }), 1, "its POST made one");
		assert.deepEqual(orgoHeld(api, requestId).live, [], "none is left");
		if (nth === 1) assert.deepEqual(channel.calls, [], "nothing is uploaded or run for a caller that is gone");
	});
}

/** The bound a test gives the cleanup a create runs for itself (cleanupMs), and the most a create may take past it. */
const CLEANUP_MS = 300;
const CLEANUP_MARGIN_MS = 2_000;
const BOUNDED = { cleanupMs: CLEANUP_MS, confirm: { polls: 1, intervalMs: 1 } };

/**
 * A vendor's fetch whose releases (Browserbase's POST, Kernel's DELETE, on the browser's own path) never answer: each
 * waits for its signal, and one sent with none waits for ever. `asked` counts them.
 */
const stallingRelease = (fetch) => {
	const stalled = async (input, init = {}) => {
		if ((init.method ?? "GET") !== "GET" && /\/(sessions|browsers)\/[^/]+$/.test(new URL(String(input)).pathname)) {
			stalled.asked++;
			// As fetch does: a signal already aborted rejects at once.
			if (init.signal?.aborted) return Promise.reject(init.signal.reason);
			return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		}
		return fetch(input, init);
	};
	stalled.asked = 0;
	return stalled;
};

/** What `run` answers and how long it took; a test's own timeout stops one that never answers. */
const timed = async (run) => {
	const started = Date.now();
	const result = await run();
	return { result, ms: Date.now() - started };
};

for (const [id, cloud] of Object.entries(CLOUD_BROWSERS)) {
	const vendor = VENDORS[id];

	test(`${id}: a create aborted after its POST whose release never answers is aborted within its cleanup's bound, and a retry is refused`, { timeout: 15_000 }, async () => {
		const fake = vendor.vendor();
		const controller = new AbortController();
		const fetch = stallingRelease(fake.fetch);
		const provider = await vendor.make({ ...fake, fetch: abortingListing(fetch, cloud.post, cloud.post, 1, controller) }, BOUNDED);
		const requestId = requestOf(`${id}-stalled-abort`);
		const { result, ms } = await timed(() => provider.create(vendor.spec(), { requestId, signal: controller.signal }));
		assert.equal(result.ok, false, "an aborted create");
		assert.equal(result.error.code, "aborted", result.error.message);
		assert.match(result.error.message, /may still be running/);
		assert.ok(ms < CLEANUP_MS + CLEANUP_MARGIN_MS, `answered in ${ms} ms`);
		assert.ok(fetch.asked > 0, "its release was asked");
		const retry = await timed(() => provider.create(vendor.spec(), { requestId }));
		assert.equal(retry.result.ok, false, "the retry");
		assert.equal(retry.result.error.code, "exists", retry.result.error.message);
		assert.ok(retry.ms < CLEANUP_MARGIN_MS, `the retry answered in ${retry.ms} ms`);
		assert.equal(vendor.made(fake), 1, "no second browser");
	});

	test(`${id}: a create whose browser is the newer and whose release never answers fails within its cleanup's bound, and a retry answers the older`, { timeout: 15_000 }, async () => {
		const fake = vendor.vendor();
		const fetch = stallingRelease(fake.fetch);
		const shared = { ...fake, fetch: createsTogether(fetch, cloud.post, 2) };
		const [one, two] = [await vendor.make(shared, BOUNDED), await vendor.make(shared, BOUNDED)];
		const requestId = requestOf(`${id}-stalled-newer`);
		const { result, ms } = await timed(() => Promise.all([one.create(vendor.spec(), { requestId }), two.create(vendor.spec(), { requestId })]));
		const [a, b] = result;
		const kept = okOf(a, "the older's create");
		assert.equal(b.ok, false, "the newer's create, its release stalled");
		assert.match(b.error.message, /may still be running/);
		assert.ok(ms < CLEANUP_MS + CLEANUP_MARGIN_MS, `answered in ${ms} ms`);
		const retry = await timed(() => two.create(vendor.spec(), { requestId }));
		assert.equal(okOf(retry.result, "the retry").id, kept.id, "the retry answers the older");
		assert.ok(retry.ms < CLEANUP_MARGIN_MS, `the retry answered in ${retry.ms} ms`);
	});

	test(`${id}: a create whose browser has no usable CDP URL and whose release never answers fails within its cleanup's bound, and a retry is refused`, { timeout: 15_000 }, async () => {
		const fake = cloud.unusable();
		const fetch = stallingRelease(fake.fetch);
		const provider = await vendor.make({ ...fake, fetch }, BOUNDED);
		const requestId = requestOf(`${id}-stalled-unusable`);
		const { result, ms } = await timed(() => provider.create(vendor.spec(), { requestId }));
		assert.equal(result.ok, false, "a create with no CDP URL to hand over");
		assert.match(result.error.message, /no CDP URL to hand over/);
		assert.match(result.error.message, /may still be running/);
		assert.ok(ms < CLEANUP_MS + CLEANUP_MARGIN_MS, `answered in ${ms} ms`);
		assert.ok(fetch.asked > 0, "its release was asked");
		const retry = await timed(() => provider.create(vendor.spec(), { requestId }));
		assert.equal(retry.result.ok, false, "the retry");
		assert.equal(retry.result.error.code, "exists", retry.result.error.message);
		assert.ok(retry.ms < CLEANUP_MARGIN_MS, `the retry answered in ${retry.ms} ms`);
		assert.equal(vendor.made(fake), 1, "no second browser");
	});

	test(`${id}: a create whose reply is lost and whose release never answers fails within its cleanup's bound, and a retry is refused`, { timeout: 15_000 }, async () => {
		const fake = vendor.vendor();
		const stalled = stallingRelease(fake.fetch);
		const fetch = async (input, init = {}) => {
			if ((init.method ?? "GET") === "POST" && new URL(String(input)).pathname === cloud.post) {
				await fake.fetch(input, init);
				// The vendor made the browser, and its reply never comes.
				throw new TypeError("fetch failed");
			}
			return stalled(input, init);
		};
		const provider = await vendor.make({ ...fake, fetch }, BOUNDED);
		const requestId = requestOf(`${id}-stalled-lost`);
		const { result, ms } = await timed(() => provider.create(vendor.spec(), { requestId }));
		assert.equal(result.ok, false, "the lost create");
		assert.match(result.error.message, /may still be running/);
		assert.ok(ms < CLEANUP_MS + CLEANUP_MARGIN_MS, `answered in ${ms} ms`);
		assert.ok(stalled.asked > 0, "its release was asked");
		const retry = await timed(() => provider.create(vendor.spec(), { requestId }));
		assert.equal(retry.result.ok, false, "the retry");
		assert.equal(retry.result.error.code, "exists", retry.result.error.message);
		assert.ok(retry.ms < CLEANUP_MARGIN_MS, `the retry answered in ${retry.ms} ms`);
		assert.equal(vendor.made(fake), 1, "no second browser");
	});
}

test("orgo: a create aborted after Orgo's answer whose delete never answers is aborted within Orgo's request bound, and a retry is refused", { timeout: 15_000 }, async () => {
	const { api, channel } = VENDORS.orgo.vendor();
	const controller = new AbortController();
	let asked = 0;
	const stalled = async (input, init = {}) => {
		if (init.method === "DELETE" && /\/computers\/[^/]+$/.test(new URL(String(input)).pathname)) {
			asked++;
			if (init.signal?.aborted) return Promise.reject(init.signal.reason);
			return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
		}
		return api.fetch(input, init);
	};
	const provider = await VENDORS.orgo.make({ api: { ...api, fetch: abortingListing(stalled, "/computers", `/workspaces/${WORKSPACE}`, 1, controller) }, channel });
	const requestId = requestOf("orgo-stalled-abort");
	const { result, ms } = await timed(() => provider.create(VENDORS.orgo.spec(), { requestId, signal: controller.signal }));
	assert.equal(result.ok, false, "an aborted create");
	assert.equal(result.error.code, "aborted", result.error.message);
	assert.match(result.error.message, /could not be deleted/);
	assert.ok(ms < ORGO_TIMEOUTS.requestMs + CLEANUP_MARGIN_MS, `answered in ${ms} ms`);
	assert.ok(asked > 0, "its delete was asked");
	const retry = await timed(() => provider.create(VENDORS.orgo.spec(), { requestId }));
	assert.equal(retry.result.ok, false, "the retry");
	assert.equal(retry.result.error.code, "exists", retry.result.error.message);
	assert.ok(retry.ms < CLEANUP_MARGIN_MS, `the retry answered in ${retry.ms} ms`);
	assert.equal(VENDORS.orgo.made({ api }), 1, "no second computer");
});

test("a lost create's browser is left to another create of its request only when it is the oldest that runs and a newer one was made", async () => {
	const { leftToConverge } = await import("../dist/browser.js");
	const at = (id, minute, live = true) => ({ id, createdAt: `2026-01-01T00:0${minute}:00.000Z`, labels: {}, live });
	assert.equal(leftToConverge("b", [at("b", 1)]), false, "the request's only browser is released");
	assert.equal(leftToConverge("b", [at("b", 1), at("a", 2, false)]), true, "the oldest that runs, a newer one released by its converge: left");
	assert.equal(leftToConverge("b", [at("b", 1), at("a", 2)]), true, "the oldest that runs, a newer one still running: left");
	assert.equal(leftToConverge("b", [at("a", 1), at("b", 2)]), false, "an older one runs: released");
	assert.equal(leftToConverge("b", [at("a", 1), at("b", 2), at("c", 3)]), false, "an older one runs, though a newer was made: released");
	assert.equal(leftToConverge("b", [at("a", 1, false), at("b", 2), at("c", 3, false)]), true, "the older ended, a newer made: left");
	assert.equal(leftToConverge("b", [at("b", 1, false), at("a", 2)]), false, "already ended: released");
	assert.equal(leftToConverge("b", [at("a", 2)]), false, "not listed: released");
});

test("a create's lookup reads the request again while two or more of its browsers run, until one is left, within its bound; a failed read or the bound gives the last listing, and an abort is refused", async () => {
	const { lookupSettled } = await import("../dist/browser.js");
	const at = (id, minute) => ({ id, createdAt: `2026-01-01T00:0${minute}:00.000Z`, labels: {} });
	const reader = (answers) => {
		const asked = { reads: 0, sleeps: [] };
		return { asked, read: async () => answers[Math.min(asked.reads++, answers.length - 1)], sleep: async (ms) => void asked.sleeps.push(ms) };
	};
	const one = reader([]);
	assert.deepEqual(okOf(await lookupSettled([at("a", 1)], one.read, one.sleep, 30_000, "Fake")).map((b) => b.id), ["a"], "one runs: answered at once");
	assert.equal(one.asked.reads, 0, "one running browser is never read again");
	const left = reader([{ ok: true, value: [at("a", 1), at("b", 2)] }, { ok: true, value: [at("b", 2)] }]);
	assert.deepEqual(okOf(await lookupSettled([at("a", 1), at("b", 2)], left.read, left.sleep, 30_000, "Fake")).map((b) => b.id), ["b"], "the one left once the other ended");
	assert.equal(left.asked.reads, 2, "read until one was left");
	assert.deepEqual(left.asked.sleeps, [2_000, 2_000], "each read after a 2 s wait");
	const both = reader([{ ok: true, value: [at("a", 1), at("b", 2)] }]);
	assert.deepEqual(okOf(await lookupSettled([at("a", 1), at("b", 2)], both.read, both.sleep, 7_000, "Fake")).map((b) => b.id), ["a", "b"], "both still run at the bound: the last listing");
	assert.equal(both.asked.reads, 4, "as many reads as 2 s waits fit in the bound, rounded up (7 s: 4)");
	const failed = reader([{ ok: false, error: { code: "unavailable", message: "503" } }]);
	assert.deepEqual(okOf(await lookupSettled([at("a", 1), at("b", 2)], failed.read, failed.sleep, 30_000, "Fake")).map((b) => b.id), ["a", "b"], "a failed read: the last listing");
	assert.equal(failed.asked.reads, 1, "no read after one that failed");
	const controller = new AbortController();
	const aborted = reader([{ ok: true, value: [at("a", 1), at("b", 2)] }]);
	const cut = await lookupSettled([at("a", 1), at("b", 2)], aborted.read, async () => controller.abort(), 30_000, "Fake", controller.signal);
	assert.equal(cut.ok, false, "aborted while it waited");
	assert.equal(cut.error.code, "aborted");
	assert.equal(aborted.asked.reads, 0, "no read once the caller's signal ended");
});

test("browserbase: a lost create's recovery that reads the request's sessions while another instance's converge releases its newer one still finds it, and leaves the older", async () => {
	const vendor = VENDORS.browserbase;
	const fake = vendor.vendor();
	const requestId = requestOf("browserbase-lost-moving");
	const gate = () => {
		let open;
		const opened = new Promise((resolve) => (open = resolve));
		return { open, opened };
	};
	// A looks first (none); B's POST makes the older session, A's the newer; B's reply is lost once A's POST is answered.
	// B's recovery reads the request's sessions by status while A's converge releases A's own (RUNNING to COMPLETED): its
	// RUNNING query is answered only after that release, so a read that asks COMPLETED before (or beside) RUNNING misses
	// A's session in both.
	const looked = gate();
	const madeB = gate();
	const madeA = gate();
	const reading = gate();
	const releasedA = gate();
	const path = (input) => new URL(String(input)).pathname;
	const isPost = (input, init) => (init.method ?? "GET") === "POST" && path(input) === "/v1/sessions";
	const isList = (input, init) => (init.method ?? "GET") === "GET" && path(input) === "/v1/sessions";
	const isRelease = (input, init) => (init.method ?? "GET") === "POST" && /^\/v1\/sessions\/[^/]+$/.test(path(input));
	let postedA = false;
	let listsA = 0;
	const fetchA = async (input, init = {}) => {
		if (isPost(input, init)) {
			await madeB.opened;
			const answer = await fake.fetch(input, init);
			postedA = true;
			madeA.open();
			return answer;
		}
		if (isList(input, init) && postedA) await reading.opened;
		const answer = await fake.fetch(input, init);
		if (isList(input, init) && ++listsA === 1) looked.open();
		if (isRelease(input, init)) releasedA.open();
		return answer;
	};
	let postedB = false;
	const fetchB = async (input, init = {}) => {
		if (isPost(input, init)) {
			await looked.opened;
			await fake.fetch(input, init);
			postedB = true;
			madeB.open();
			await madeA.opened;
			// The vendor made B's session, and its reply never comes.
			throw new TypeError("fetch failed");
		}
		const url = new URL(String(input));
		if (postedB && isList(input, init) && (url.searchParams.get("q") ?? "").includes("agentrun_create")) {
			reading.open();
			if (url.searchParams.get("status") === "RUNNING") await releasedA.opened;
		}
		return fake.fetch(input, init);
	};
	const one = await vendor.make({ ...fake, fetch: fetchA });
	const two = await vendor.make({ ...fake, fetch: fetchB });
	const [a, b] = await Promise.all([one.create(vendor.spec(), { requestId }), two.create(vendor.spec(), { requestId })]);
	const kept = okOf(a, "A's create");
	assert.equal(b.ok, false, "B's create, its reply lost");
	const [older, newer] = CLOUD_BROWSERS.browserbase.ids(fake);
	assert.equal(kept.id, older, "A's converge answers B's session, the older");
	assert.equal(CLOUD_BROWSERS.browserbase.live(fake, newer), false, "A's own session, the newer, is released");
	assert.equal(CLOUD_BROWSERS.browserbase.live(fake, older), true, "the session A answered still runs after B's recovery");
	assert.match(b.error.message, /left running/);
	okOf(await one.release(kept, "delete"), "release");
});

test("browserbase: a create whose lookup reads the request's session as it goes from PENDING to RUNNING answers it, never makes a second", async () => {
	const vendor = VENDORS.browserbase;
	const fake = vendor.vendor();
	const requestId = requestOf("browserbase-lookup-moving");
	const one = await vendor.make(fake);
	const made = okOf(await one.create(vendor.spec(), { requestId }), "A's create");
	const session = fake.sessions.get(made.id);
	session.status = "PENDING";
	// The session starts running once the lookup's first query is answered: a lookup that asks RUNNING before PENDING
	// finds it in neither.
	let answered = 0;
	const fetch = async (input, init = {}) => {
		const answer = await fake.fetch(input, init);
		if ((init.method ?? "GET") === "GET" && new URL(String(input)).pathname === "/v1/sessions" && ++answered === 1) session.status = "RUNNING";
		return answer;
	};
	const two = await vendor.make({ ...fake, fetch });
	const found = okOf(await two.create(vendor.spec(), { requestId }), "B's create");
	assert.equal(found.id, made.id, "B answers the request's session");
	assert.equal(vendor.made(fake), 1, "no second session");
	okOf(await one.release(made, "delete"), "release");
});

test("a left browser's request read again: answered once a newer one has ended, running while every newer one runs, released once it is no longer left", async () => {
	const { convergeSettled } = await import("../dist/browser.js");
	const at = (id, minute, live = true) => ({ id, createdAt: `2026-01-01T00:0${minute}:00.000Z`, labels: {}, live });
	assert.equal(convergeSettled("b", [at("b", 1), at("a", 2, false)]), "answered", "the newer ended, as a converge that answers the older ends its own");
	assert.equal(convergeSettled("b", [at("b", 1), at("a", 2)]), "running", "the newer still runs: no converge answered mine");
	assert.equal(convergeSettled("b", [at("b", 1), at("a", 2), at("c", 3, false)]), "answered", "one newer ended, another runs: one converge may have answered mine");
	assert.equal(convergeSettled("b", [at("b", 1), at("a", 2), at("c", 3)]), "running", "every newer one runs");
	assert.equal(convergeSettled("b", [at("b", 1, false), at("a", 2, false)]), "release", "mine has ended");
	assert.equal(convergeSettled("b", [at("x", 0), at("b", 1), at("a", 2)]), "release", "an older one runs, every newer one too");
	assert.equal(convergeSettled("b", [at("x", 0), at("b", 1), at("a", 2, false)]), "answered-older", "an older one runs and a newer ended: a converge whose list missed the older may have answered mine, or it answered the older");
	assert.equal(convergeSettled("b", [at("a", 2)]), "unread", "mine not listed: the read says nothing of it");
	assert.equal(convergeSettled("b", [at("b", 1)]), "unread", "no newer one listed, though one was: the read says nothing of it");
	assert.equal(convergeSettled("b", [at("a", 0, false), at("b", 1), at("c", 2)]), "running", "an ended older one is no newer one");
});

/** A real wait that records what it was asked for. */
const recordedSleep = () => {
	const asked = [];
	const sleep = (ms) => {
		asked.push(ms);
		return new Promise((resolve) => setTimeout(resolve, ms));
	};
	return { asked, sleep };
};

/** A gate a test opens once: `opened` resolves then. */
const openable = () => {
	let open;
	const opened = new Promise((resolve) => (open = resolve));
	return { open, opened };
};

/** What a vendor call is, as the tests of two instances on one cloud vendor read it. */
const callOf = (cloud, input, init = {}) => {
	const method = init.method ?? "GET";
	const path = new URL(String(input)).pathname;
	return {
		method,
		path,
		post: method === "POST" && path === cloud.post,
		list: method === "GET" && path === cloud.post,
		/** A release: Browserbase's POST, Kernel's DELETE, on the browser's own path. */
		release: method !== "GET" && /\/(sessions|browsers)\/[^/]+$/.test(path),
		/** A read of one browser by its id. */
		read: (id) => method === "GET" && path.endsWith(`/${id}`),
	};
};

/** A vendor's failure answer, the status alone. */
const failing = (status) => new Response(JSON.stringify({ error: "fake failure" }), { status, headers: { "content-type": "application/json" } });

/**
 * Two instances' creates of one request, B's reply lost: A looks for the request's browser first (none), then B's POST
 * makes the older browser, then A's POST the newer; B's recovery runs once A's create has answered. `wrapA` wraps A's
 * vendor calls (its fetch, already ordered), `wrapB` B's, `signalA` is A's caller's signal, `sleepB` is B's sleep and
 * `optionsB` B's provider options. `recoverMs` is how long B took from its lost reply to its answer.
 */
const lostOlder = async (vendor, cloud, fake, requestId, { wrapA = (fetch) => fetch, wrapB = (fetch) => fetch, signalA, sleepB, optionsB = {} } = {}) => {
	const looked = openable();
	const madeB = openable();
	const answered = openable();
	let listsA = 0;
	const fetchA = async (input, init = {}) => {
		const call = callOf(cloud, input, init);
		if (call.post) await madeB.opened;
		const answer = await fake.fetch(input, init);
		if (call.list && ++listsA === 1) looked.open();
		return answer;
	};
	const fetchB = async (input, init = {}) => {
		if (callOf(cloud, input, init).post) {
			await looked.opened;
			await fake.fetch(input, init);
			madeB.open();
			await answered.opened;
			lostAt = Date.now();
			// The vendor made B's browser, and its reply never comes.
			throw new TypeError("fetch failed");
		}
		return fake.fetch(input, init);
	};
	let lostAt = 0;
	const one = await vendor.make({ ...fake, fetch: wrapA(fetchA) });
	const two = await vendor.make({ ...fake, fetch: wrapB(fetchB) }, { ...(sleepB ? { sleep: sleepB } : {}), ...optionsB });
	const first = one.create(vendor.spec(), { requestId, ...(signalA ? { signal: signalA } : {}) }).finally(() => answered.open());
	const [a, b] = await Promise.all([first, two.create(vendor.spec(), { requestId })]);
	const recoverMs = Date.now() - lostAt;
	const [older, newer] = cloud.ids(fake);
	return { one, a, b, older, newer, recoverMs };
};

for (const [id, cloud] of Object.entries(CLOUD_BROWSERS)) {
	const vendor = VENDORS[id];

	test(`${id}: a lost create's browser left for a newer one whose create's converge could not list the request (5xx) and kept its own is released`, async () => {
		const fake = vendor.vendor();
		const wrapA = (fetch) => {
			let posted = false;
			let failed = false;
			return async (input, init = {}) => {
				const call = callOf(cloud, input, init);
				if (call.post) posted = true;
				else if (posted && call.list && !failed) {
					failed = true;
					return failing(503);
				}
				return fetch(input, init);
			};
		};
		const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-left-unlisted`), { wrapA });
		const kept = okOf(a, "A's create, its converge's listing failed");
		assert.equal(kept.id, newer, "A answers its own, the newer");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.equal(cloud.live(fake, newer), true, "the browser A answered still runs");
		assert.equal(cloud.live(fake, older), false, "the browser B's lost create made, answered by nobody, is released");
		assert.match(b.error.message, /was released, since every newer .* still runs/);
		assert.ok(cloud.releases(fake, older) > 0, "B's recovery asked the vendor to release its browser");
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a third create that finds a lost create's browser and a newer one both running waits until one is left, so it never answers the one the lost create's recovery releases`, async () => {
		const fake = vendor.vendor();
		const requestId = requestOf(`${id}-lookup-while-newer`);
		const wrapA = (fetch) => {
			let posted = false;
			let failed = false;
			return async (input, init = {}) => {
				const call = callOf(cloud, input, init);
				if (call.post) posted = true;
				else if (posted && call.list && !failed) {
					failed = true;
					return failing(503);
				}
				return fetch(input, init);
			};
		};
		// X looks for the request's browser while B's recovery reads it again: both B's and A's run, and B's is the older.
		const xLooked = openable();
		let xLists = 0;
		const three = await vendor.make(
			{
				...fake,
				fetch: async (input, init = {}) => {
					const answer = await fake.fetch(input, init);
					if (callOf(cloud, input, init).list && ++xLists === 1) xLooked.open();
					return answer;
				},
			},
			{ sleep: () => new Promise((resolve) => setTimeout(resolve, 20)) },
		);
		let x;
		let sleeps = 0;
		const sleepB = async () => {
			if (++sleeps > 1) return;
			x = three.create(vendor.spec(), { requestId });
			await xLooked.opened;
		};
		const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestId, { wrapA, sleepB });
		const kept = okOf(a, "A's create, its converge's listing failed");
		assert.equal(kept.id, newer, "A answers its own, the newer");
		assert.match(b.error.message, /was released, since every newer .* still runs/);
		assert.equal(cloud.live(fake, older), false, "the browser B's lost create made, answered by no converge, is released");
		assert.ok(x !== undefined, "X's create ran while B's recovery read the request again");
		const third = okOf(await x, "X's create");
		assert.equal(third.id, newer, "X answers the browser that still runs, never the one B's recovery released");
		assert.equal(cloud.live(fake, newer), true, "the browser A and X answered runs");
		assert.equal(vendor.made(fake), 2, "X made no browser of its own");
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create's browser left for a newer one whose create could not release its own is released`, async () => {
		const fake = vendor.vendor();
		const wrapA = (fetch) => async (input, init = {}) => (callOf(cloud, input, init).release ? failing(500) : fetch(input, init));
		const { a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-left-unreleased`), { wrapA });
		assert.equal(a.ok, false, "A's create, its own browser's release failed");
		assert.match(a.error.message, /could not be (released|deleted)/);
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.equal(cloud.live(fake, newer), true, "A's own browser still runs (its failure says so)");
		assert.equal(cloud.live(fake, older), false, "the browser B's lost create made, answered by nobody, is released");
		assert.match(b.error.message, /was released, since every newer .* still runs/);
		assert.ok(cloud.releases(fake, older) > 0, "B's recovery asked the vendor to release its browser");
	});

	test(`${id}: a lost create's browser left for a newer one whose create's converge is still releasing its own at the first read again is kept, and that create answers it`, async () => {
		const fake = vendor.vendor();
		// B's reply is lost once A's converge asks to release A's own; that release goes on only after B's first read again
		// (B's second sleep), and B's next read waits for it: B's recovery runs beside A's converge.
		const looked = openable();
		const madeB = openable();
		const releasing = openable();
		const recheckedOnce = openable();
		const releasedA = openable();
		let sleeps = 0;
		const sleepB = async () => {
			if (++sleeps === 2) {
				recheckedOnce.open();
				await releasedA.opened;
			}
		};
		let listsA = 0;
		const fetchA = async (input, init = {}) => {
			const call = callOf(cloud, input, init);
			if (call.post) await madeB.opened;
			if (call.release) {
				releasing.open();
				await recheckedOnce.opened;
				const answer = await fake.fetch(input, init);
				releasedA.open();
				return answer;
			}
			const answer = await fake.fetch(input, init);
			if (call.list && ++listsA === 1) looked.open();
			return answer;
		};
		const fetchB = async (input, init = {}) => {
			if (callOf(cloud, input, init).post) {
				await looked.opened;
				await fake.fetch(input, init);
				madeB.open();
				await releasing.opened;
				// The vendor made B's browser, and its reply never comes.
				throw new TypeError("fetch failed");
			}
			return fake.fetch(input, init);
		};
		const requestId = requestOf(`${id}-left-converging`);
		const one = await vendor.make({ ...fake, fetch: fetchA });
		const two = await vendor.make({ ...fake, fetch: fetchB }, { sleep: sleepB });
		const [a, b] = await Promise.all([one.create(vendor.spec(), { requestId }), two.create(vendor.spec(), { requestId }).finally(() => recheckedOnce.open())]);
		const kept = okOf(a, "A's create");
		assert.equal(b.ok, false, "B's create, its reply lost");
		const [older, newer] = cloud.ids(fake);
		assert.equal(kept.id, older, "A's converge answers B's browser, the older");
		assert.equal(cloud.live(fake, newer), false, "A's own browser, the newer, is released");
		assert.equal(cloud.live(fake, older), true, "the browser A answered still runs after B's recovery");
		assert.ok(sleeps >= 2, "B read the request again more than once");
		assert.match(b.error.message, /left running/);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create's recovery under a short cleanup bound and real waits reads the request again within it, and releases the browser no converge answered`, { timeout: 15_000 }, async () => {
		const fake = vendor.vendor();
		const wrapA = (fetch) => {
			let posted = false;
			let failed = false;
			return async (input, init = {}) => {
				const call = callOf(cloud, input, init);
				if (call.post) posted = true;
				else if (posted && call.list && !failed) {
					failed = true;
					return failing(503);
				}
				return fetch(input, init);
			};
		};
		// B waits for real, and half its bound is shorter than the gap between reads: its first wait is cut to that half.
		const cleanupMs = 3_000;
		const { asked, sleep } = recordedSleep();
		const optionsB = { cleanupMs, confirm: { polls: 1, intervalMs: 1 }, sleep };
		const { one, a, b, older, newer, recoverMs } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-left-short-bound`), { wrapA, optionsB });
		const kept = okOf(a, "A's create, its converge's listing failed");
		assert.equal(kept.id, newer, "A answers its own, the newer");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.equal(cloud.live(fake, older), false, "the browser B's lost create made, answered by nobody, is released");
		assert.match(b.error.message, /was released, since every newer .* still runs/);
		assert.ok(asked.length > 0 && asked.every((ms) => ms <= cleanupMs / 2), `B's waits (${asked.join(", ")} ms) each within half its ${cleanupMs} ms bound`);
		assert.ok(recoverMs < cleanupMs + 1_000, `B's recovery answered in ${recoverMs} ms, within its ${cleanupMs} ms bound`);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create's browser left for a newer one is kept when the request cannot be read again, never released, in words that say so`, async () => {
		const fake = vendor.vendor();
		// A's converge listing fails, so A keeps its own and the newer runs throughout: a read again that answered would
		// release B's. B's sleep comes only before a read again (its find answers at once), and from then on every list
		// B asks for fails.
		let rereading = false;
		const sleepB = async () => {
			rereading = true;
		};
		const wrapA = (fetch) => {
			let posted = false;
			let failed = false;
			return async (input, init = {}) => {
				const call = callOf(cloud, input, init);
				if (call.post) posted = true;
				else if (posted && call.list && !failed) {
					failed = true;
					return failing(503);
				}
				return fetch(input, init);
			};
		};
		const failingReads = (fetch) => async (input, init = {}) => (rereading && callOf(cloud, input, init).list ? failing(503) : fetch(input, init));
		const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-left-unread-again`), { wrapA, sleepB, wrapB: failingReads });
		const kept = okOf(a, "A's create, its converge's listing failed");
		assert.equal(kept.id, newer, "A answers its own, the newer");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.ok(rereading, "B read the request again");
		assert.equal(cloud.live(fake, older), true, "B's browser is kept: a read again that fails says nothing about who holds it");
		assert.equal(cloud.releases(fake, older), 0, "no release of B's browser was asked");
		assert.match(b.error.message, /could not be read again: it is left running, at most to its lifetime/);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create's browser left for a newer one whose create was aborted during its converge's listing runs to its lifetime, in words that say so`, async () => {
		const fake = vendor.vendor();
		const controller = new AbortController();
		const wrapA = (fetch) => abortingListing(fetch, cloud.post, cloud.post, 1, controller);
		const { a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-left-aborted`), { wrapA, signalA: controller.signal });
		assert.equal(a.ok, false, "A's create, aborted");
		assert.equal(a.error.code, "aborted", a.error.message);
		assert.equal(cloud.live(fake, newer), false, "A's own browser is released");
		assert.equal(cloud.live(fake, older), true, "B's browser is left: an ended newer one reads as a converge that answered it");
		assert.match(b.error.message, /left running .*runs to its lifetime/);
		assert.equal(cloud.releases(fake, older), 0, "no release of B's browser was asked");
	});

	test(`${id}: a lost create's browser left for a newer one whose create released its own and could not read the older runs to its lifetime, in words that say so`, async () => {
		const fake = vendor.vendor();
		const wrapA = (fetch) => {
			let posted = false;
			return async (input, init = {}) => {
				const call = callOf(cloud, input, init);
				if (call.post) posted = true;
				else if (posted && call.read(cloud.ids(fake)[0])) return failing(500);
				return fetch(input, init);
			};
		};
		const { a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-left-unread`), { wrapA });
		assert.equal(a.ok, false, "A's create, its read of the older failed");
		assert.equal(cloud.live(fake, newer), false, "A's own browser is released");
		assert.equal(cloud.live(fake, older), true, "B's browser is left: an ended newer one reads as a converge that answered it");
		assert.match(b.error.message, /left running .*runs to its lifetime/);
		assert.equal(cloud.releases(fake, older), 0, "no release of B's browser was asked");
	});

	test(`${id}: two lost creates of one request: the newer's recovery releases its own, and the older's browser runs to its lifetime, in words that say so`, async () => {
		const fake = vendor.vendor();
		const requestId = requestOf(`${id}-left-two-lost`);
		const lookedB = openable();
		const lookedC = openable();
		const madeB = openable();
		const doneC = openable();
		const instance = (looked, before, after) => {
			let lists = 0;
			return async (input, init = {}) => {
				const call = callOf(cloud, input, init);
				if (call.post) {
					await Promise.all([lookedB.opened, lookedC.opened, before]);
					await fake.fetch(input, init);
					await after();
					// The vendor made the browser, and its reply never comes.
					throw new TypeError("fetch failed");
				}
				const answer = await fake.fetch(input, init);
				if (call.list && ++lists === 1) looked.open();
				return answer;
			};
		};
		const two = await vendor.make({ ...fake, fetch: instance(lookedB, undefined, async () => { madeB.open(); await doneC.opened; }) });
		const three = await vendor.make({ ...fake, fetch: instance(lookedC, madeB.opened, async () => {}) });
		const [b, c] = await Promise.all([two.create(vendor.spec(), { requestId }), three.create(vendor.spec(), { requestId }).finally(() => doneC.open())]);
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.equal(c.ok, false, "C's create, its reply lost");
		const [older, newer] = cloud.ids(fake);
		assert.equal(cloud.live(fake, newer), false, "C's browser, the newer, is released by its recovery");
		assert.match(c.error.message, /was released/);
		assert.equal(cloud.live(fake, older), true, "B's browser is left: an ended newer one reads as a converge that answered it");
		assert.match(b.error.message, /left running .*runs to its lifetime/);
		assert.equal(cloud.releases(fake, older), 0, "no release of B's browser was asked");
	});
}

/** A JSON answer of rows, with the headers given. */
const rowsAnswer = (rows, headers = {}) => new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json", ...headers } });

test("browserbase: a lost create's recovery whose read answers the newer session both as running and as ended reads it as ended, and keeps the older A's converge answered", async () => {
	const vendor = VENDORS.browserbase;
	const cloud = CLOUD_BROWSERS.browserbase;
	const fake = vendor.vendor();
	// Once A's converge has ended its own (the newer), each RUNNING answer B gets still carries that session as RUNNING,
	// as an answer read before it ended would: the COMPLETED answer B asks next holds it too.
	let stale = 0;
	const wrapB = (fetch) => async (input, init = {}) => {
		const answer = await fetch(input, init);
		const url = new URL(String(input));
		if ((init.method ?? "GET") !== "GET" || url.pathname !== cloud.post || url.searchParams.get("status") !== "RUNNING") return answer;
		const s = fake.sessions.get(cloud.ids(fake)[1] ?? "");
		const q = /^user_metadata\['([^']+)'\]:'([^']*)'$/.exec(url.searchParams.get("q") ?? "");
		if (s === undefined || s.status === "RUNNING" || (q !== null && s.userMetadata[q[1]] !== q[2])) return answer;
		stale++;
		const rows = await answer.json();
		return rowsAnswer([...rows, { id: s.id, status: "RUNNING", projectId: "proj_fake", createdAt: s.createdAt, expiresAt: s.expiresAt, keepAlive: s.keepAlive, userMetadata: { ...s.userMetadata } }]);
	};
	const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf("browserbase-left-both-answers"), { wrapB });
	const kept = okOf(a, "A's create");
	assert.equal(kept.id, older, "A's converge answers B's session, the older");
	assert.equal(b.ok, false, "B's create, its reply lost");
	assert.ok(stale > 0, "B's reads answered the newer session as running too");
	assert.equal(cloud.live(fake, newer), false, "A's own session, the newer, is released");
	assert.equal(cloud.live(fake, older), true, "the session A answered still runs after B's recovery");
	assert.equal(cloud.releases(fake, older), 0, "no release of the session A answered was asked");
	assert.match(b.error.message, /left running/);
	okOf(await one.release(kept, "delete"), "release");
});

test("kernel: a lost create's recovery whose paged read lists the newer browser as running on one page and as deleted on a later one reads it as deleted, and keeps the older A's converge answered", async () => {
	const vendor = VENDORS.kernel;
	const cloud = CLOUD_BROWSERS.kernel;
	const fake = vendor.vendor();
	// Once A's converge has deleted its own (the newer), each of B's reads of every state gets a first page that still
	// holds it running, as a page read before the delete would, and then the vendor's own answer, which holds it deleted.
	let stale = 0;
	const wrapB = (fetch) => async (input, init = {}) => {
		const url = new URL(String(input));
		if ((init.method ?? "GET") !== "GET" || url.pathname !== cloud.post || url.searchParams.get("status") !== "all") return fetch(input, init);
		const newer = cloud.ids(fake)[1];
		const row = newer === undefined ? undefined : fake.browsers.get(newer);
		const tagged = [...url.searchParams].every(([key, value]) => !/^tags\[/.test(key) || row?.tags[/^tags\[(.+)\]$/.exec(key)[1]] === value);
		if (row === undefined || row.deletedAt === undefined || !tagged) return fetch(input, init);
		if (url.searchParams.get("offset") === "0") {
			stale++;
			return rowsAnswer([{ session_id: newer, created_at: row.createdAt, tags: { ...row.tags } }], { "x-has-more": "true", "x-next-offset": "1" });
		}
		url.searchParams.set("offset", String(Number(url.searchParams.get("offset")) - 1));
		return fetch(url.href, init);
	};
	const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf("kernel-left-both-pages"), { wrapB });
	const kept = okOf(a, "A's create");
	assert.equal(kept.id, older, "A's converge answers B's browser, the older");
	assert.equal(b.ok, false, "B's create, its reply lost");
	assert.ok(stale > 0, "B's reads listed the newer browser as running too");
	assert.equal(cloud.live(fake, newer), false, "A's own browser, the newer, is deleted");
	assert.equal(cloud.live(fake, older), true, "the browser A answered still runs after B's recovery");
	assert.equal(cloud.releases(fake, older), 0, "no release of the browser A answered was asked");
	assert.match(b.error.message, /left running/);
	okOf(await one.release(kept, "delete"), "release");
});

/**
 * A vendor's answer to a read of a request's browsers (ended ones included), built from the fake's own browsers as the
 * test edits them: `rows` are the fake's, as { id, createdAt, live, raw }, and `answer` the vendor's answer to `url`.
 */
const REREAD = {
	browserbase: {
		rows: (fake) => [...fake.sessions.values()].map((s) => ({ id: s.id, createdAt: s.createdAt, live: s.status === "RUNNING", raw: s })),
		answer: (url, rows) =>
			rowsAnswer(
				rows
					.filter((row) => (row.live ? "RUNNING" : "COMPLETED") === url.searchParams.get("status"))
					.map(({ id, createdAt, live, raw }) => ({ id, status: live ? "RUNNING" : "COMPLETED", projectId: "proj_fake", createdAt, expiresAt: raw.expiresAt, keepAlive: raw.keepAlive, userMetadata: { ...raw.userMetadata } })),
			),
	},
	kernel: {
		rows: (fake) => [...fake.browsers.entries()].map(([id, row]) => ({ id, createdAt: row.createdAt, live: row.deletedAt === undefined, raw: row })),
		answer: (url, rows) =>
			rowsAnswer(
				url.searchParams.get("offset") === "0" ? rows.map(({ id, createdAt, live, raw }) => ({ session_id: id, created_at: createdAt, tags: { ...raw.tags }, ...(live ? {} : { deleted_at: raw.deletedAt ?? new Date().toISOString() }) })) : [],
				{ "x-has-more": "false" },
			),
	},
};

/** B's reads of its request's browsers once its POST is lost: GETs of the list by its create label (its find asks by its attempt label). */
const requestRead = (cloud, posted, input, init = {}) => posted && callOf(cloud, input, init).list && !decodeURIComponent(new URL(String(input)).search).includes("attempt");

/** A's fetch whose converge's first listing after its POST fails (5xx), so A keeps its own and the newer runs throughout. */
const unlistedA = (cloud) => (fetch) => {
	let posted = false;
	let failed = false;
	return async (input, init = {}) => {
		const call = callOf(cloud, input, init);
		if (call.post) posted = true;
		else if (posted && call.list && !failed) {
			failed = true;
			return failing(503);
		}
		return fetch(input, init);
	};
};

for (const [id, cloud] of Object.entries(CLOUD_BROWSERS)) {
	const vendor = VENDORS[id];

	for (const [when, failsAll] of [["fails once and then answers", false], ["fails every time", true]]) {
		test(`${id}: a lost create's browser A's converge answered, whose first read of the request ${when}, is kept and never released`, async () => {
			const fake = vendor.vendor();
			const requestId = requestOf(`${id}-first-read-${failsAll ? "never" : "once"}`);
			let slept = 0;
			const sleepB = async () => {
				slept++;
			};
			let failed = 0;
			const wrapB = (fetch) => {
				let posted = false;
				return async (input, init = {}) => {
					if (callOf(cloud, input, init).post) posted = true;
					if (requestRead(cloud, posted, input, init) && (failsAll || slept === 0)) {
						failed++;
						return failing(503);
					}
					return fetch(input, init);
				};
			};
			const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestId, { wrapB, sleepB });
			const kept = okOf(a, "A's create");
			assert.equal(kept.id, older, "A's converge answers B's browser, the older");
			assert.equal(b.ok, false, "B's create, its reply lost");
			assert.ok(failed > 0, "B's read of the request failed");
			assert.equal(cloud.live(fake, newer), false, "A's own browser, the newer, is released");
			assert.equal(cloud.live(fake, older), true, "the browser A answered still runs after B's recovery");
			assert.equal(cloud.releases(fake, older), 0, "no release of the browser A answered was asked");
			if (failsAll) assert.match(b.error.message, /could not be read, .*left running, at most to its lifetime/);
			else {
				assert.ok(slept > 0, "B read the request again after the failed read");
				assert.match(b.error.message, /left running for that create/);
			}
			okOf(await one.release(kept, "delete"), "release");
		});
	}

	for (const [what, edit] of [
		["misses the lost create's own", (rows, older) => rows.filter((row) => row.id !== older)],
		["misses every newer one", (rows, older) => rows.filter((row) => row.id === older)],
		[
			"shows an older one running and the newer ended",
			(rows, older) => {
				const own = rows.find((row) => row.id === older);
				const stray = { ...own, id: `${older}-stray`, createdAt: new Date(Date.parse(own.createdAt) - 60_000).toISOString(), live: true };
				return [stray, ...rows.map((row) => (row.id === older ? row : { ...row, live: false }))];
			},
		],
	]) {
		test(`${id}: a lost create's browser left for a newer one, whose read of the request again ${what}, is kept and never released`, async () => {
			const fake = vendor.vendor();
			const requestId = requestOf(`${id}-reread-${what.split(" ").slice(-2).join("-")}`);
			let rereading = false;
			const sleepB = async () => {
				rereading = true;
			};
			let edited = 0;
			const wrapB = (fetch) => {
				let posted = false;
				return async (input, init = {}) => {
					if (callOf(cloud, input, init).post) posted = true;
					if (!rereading || !requestRead(cloud, posted, input, init)) return fetch(input, init);
					edited++;
					return REREAD[id].answer(new URL(String(input)), edit(REREAD[id].rows(fake), cloud.ids(fake)[0]));
				};
			};
			const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestId, { wrapA: unlistedA(cloud), wrapB, sleepB });
			const kept = okOf(a, "A's create, its converge's listing failed");
			assert.equal(kept.id, newer, "A answers its own, the newer");
			assert.equal(b.ok, false, "B's create, its reply lost");
			assert.ok(edited > 0, "B read the request again");
			assert.equal(cloud.live(fake, older), true, "B's browser is kept: that read does not show it free");
			assert.equal(cloud.releases(fake, older), 0, "no release of B's browser was asked");
			assert.match(b.error.message, /left running/);
			okOf(await one.release(kept, "delete"), "release");
		});
	}

	test(`${id}: a lost create's browser whose first read shows an older one running and a newer one ended is kept, never released`, async () => {
		const fake = vendor.vendor();
		// A's converge answered B's browser and ended its own; every read B makes of the request also lists an older
		// browser running, one A's converge did not see.
		let edited = 0;
		const wrapB = (fetch) => {
			let posted = false;
			return async (input, init = {}) => {
				if (callOf(cloud, input, init).post) posted = true;
				if (!requestRead(cloud, posted, input, init)) return fetch(input, init);
				edited++;
				const rows = REREAD[id].rows(fake);
				const own = rows[0];
				const stray = { ...own, id: `${own.id}-stray`, createdAt: new Date(Date.parse(own.createdAt) - 60_000).toISOString(), live: true };
				return REREAD[id].answer(new URL(String(input)), [stray, ...rows]);
			};
		};
		const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-first-read-older-runs`), { wrapB });
		const kept = okOf(a, "A's create");
		assert.equal(kept.id, older, "A's converge answers B's browser");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.ok(edited > 0, "B read the request");
		assert.equal(cloud.live(fake, newer), false, "A's own browser, the newer, is released");
		assert.equal(cloud.live(fake, older), true, "the browser A answered still runs after B's recovery");
		assert.equal(cloud.releases(fake, older), 0, "no release of the browser A answered was asked");
		assert.match(b.error.message, /an older one of its request still runs/);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create whose first read fails once under a cleanup bound too short for a second read again tries it again within the bound, for real, and releases the browser no converge answered`, { timeout: 20_000 }, async () => {
		const fake = vendor.vendor();
		const cleanupMs = 6_000;
		const { asked, sleep } = recordedSleep();
		let failed = 0;
		const wrapB = (fetch) => {
			let posted = false;
			return async (input, init = {}) => {
				if (callOf(cloud, input, init).post) posted = true;
				if (requestRead(cloud, posted, input, init) && asked.length === 0) {
					failed++;
					return failing(503);
				}
				return fetch(input, init);
			};
		};
		const optionsB = { cleanupMs, confirm: { polls: 1, intervalMs: 1 }, sleep };
		const { one, a, b, older, newer, recoverMs } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-first-read-short-bound`), { wrapA: unlistedA(cloud), wrapB, optionsB });
		const kept = okOf(a, "A's create, its converge's listing failed");
		assert.equal(kept.id, newer, "A answers its own, the newer");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.ok(failed > 0, "B's first read failed");
		assert.equal(cloud.live(fake, older), false, "the browser B's lost create made, answered by nobody, is released");
		assert.match(b.error.message, /was released, since every newer .* still runs/);
		assert.ok(asked.every((ms) => ms <= cleanupMs / 2), `B's waits (${asked.join(", ")} ms) each within half its ${cleanupMs} ms bound`);
		assert.ok(recoverMs < cleanupMs + 1_000, `B's recovery answered in ${recoverMs} ms, within its ${cleanupMs} ms bound`);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: three creates of one request, the middle one's reply lost, the newest answering the oldest: the middle one's browser is kept, in words that say an older one runs`, async () => {
		const fake = vendor.vendor();
		const requestId = requestOf(`${id}-three-older-runs`);
		// X, B and A each look and find nothing; then X's POST makes the oldest, B's the middle (its reply lost once A has
		// answered) and A's the newest. A's converge answers X's, the oldest, and ends its own.
		const [lookedX, lookedB, lookedA, madeX, madeB, answeredA] = [openable(), openable(), openable(), openable(), openable(), openable()];
		const looked = () => Promise.all([lookedX.opened, lookedB.opened, lookedA.opened]);
		const instance = (onPost) => async (input, init = {}) => (callOf(cloud, input, init).post ? onPost(input, init) : fake.fetch(input, init));
		const x = await vendor.make({
			...fake,
			fetch: instance(async (input, init) => {
				lookedX.open();
				await looked();
				const answer = await fake.fetch(input, init);
				madeX.open();
				return answer;
			}),
		});
		const two = await vendor.make({
			...fake,
			fetch: instance(async (input, init) => {
				lookedB.open();
				await Promise.all([looked(), madeX.opened]);
				await fake.fetch(input, init);
				madeB.open();
				await answeredA.opened;
				// The vendor made B's browser, and its reply never comes.
				throw new TypeError("fetch failed");
			}),
		});
		const one = await vendor.make({
			...fake,
			fetch: instance(async (input, init) => {
				lookedA.open();
				await Promise.all([looked(), madeB.opened]);
				return fake.fetch(input, init);
			}),
		});
		const [made, b, a] = await Promise.all([
			x.create(vendor.spec(), { requestId }),
			two.create(vendor.spec(), { requestId }),
			one.create(vendor.spec(), { requestId }).finally(() => answeredA.open()),
		]);
		const [oldest, middle, newest] = cloud.ids(fake);
		assert.equal(okOf(made, "X's create").id, oldest, "X answers its own, the oldest");
		assert.equal(okOf(a, "A's create").id, oldest, "A's converge answers the oldest");
		assert.equal(cloud.live(fake, newest), false, "A's own, the newest, is released");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.equal(cloud.live(fake, middle), true, "B's browser is kept: a newer one ended, which a converge that missed the oldest could have done for it");
		assert.equal(cloud.releases(fake, middle), 0, "no release of B's browser was asked");
		assert.match(b.error.message, /an older one of its request still runs/);
		assert.match(b.error.message, /held by none/);
		okOf(await x.release(okOf(made, "X's create"), "delete"), "release");
	});

	test(`${id}: a lost create's browser A's converge answered, whose first read of the request does not list it, is kept and never released`, async () => {
		const fake = vendor.vendor();
		let edited = 0;
		const wrapB = (fetch) => {
			let posted = false;
			return async (input, init = {}) => {
				if (callOf(cloud, input, init).post) posted = true;
				if (!requestRead(cloud, posted, input, init)) return fetch(input, init);
				edited++;
				const [own] = cloud.ids(fake);
				return REREAD[id].answer(new URL(String(input)), REREAD[id].rows(fake).filter((row) => row.id !== own));
			};
		};
		const { one, a, b, older, newer } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-first-read-no-own`), { wrapB });
		const kept = okOf(a, "A's create");
		assert.equal(kept.id, older, "A's converge answers B's browser, the older");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.ok(edited > 0, "B read the request");
		assert.equal(cloud.live(fake, newer), false, "A's own browser, the newer, is released");
		assert.equal(cloud.live(fake, older), true, "the browser A answered still runs after B's recovery");
		assert.equal(cloud.releases(fake, older), 0, "no release of the browser A answered was asked");
		assert.match(b.error.message, /could not be read, or did not list it, .*left running, at most to its lifetime/);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create whose first read once does not list its browser tries it again, for real, and releases the browser no converge answered`, { timeout: 20_000 }, async () => {
		const fake = vendor.vendor();
		const cleanupMs = 6_000;
		const { asked, sleep } = recordedSleep();
		// B's reads of the request before its first wait leave out its own browser; the read after that wait lists it.
		let edited = 0;
		const wrapB = (fetch) => {
			let posted = false;
			return async (input, init = {}) => {
				if (callOf(cloud, input, init).post) posted = true;
				if (!requestRead(cloud, posted, input, init) || asked.length > 0) return fetch(input, init);
				edited++;
				const [own] = cloud.ids(fake);
				return REREAD[id].answer(new URL(String(input)), REREAD[id].rows(fake).filter((row) => row.id !== own));
			};
		};
		const optionsB = { cleanupMs, confirm: { polls: 1, intervalMs: 1 }, sleep };
		const { one, a, b, older, newer, recoverMs } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-first-read-own-late`), { wrapA: unlistedA(cloud), wrapB, optionsB });
		const kept = okOf(a, "A's create, its converge's listing failed");
		assert.equal(kept.id, newer, "A answers its own, the newer");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.ok(edited > 0, "B's first read left out its browser");
		assert.equal(cloud.live(fake, older), false, "the browser B's lost create made, answered by nobody, is released");
		assert.match(b.error.message, /was released, since every newer .* still runs/);
		assert.ok(asked.every((ms) => ms <= cleanupMs / 2), `B's waits (${asked.join(", ")} ms) each within half its ${cleanupMs} ms bound`);
		assert.ok(recoverMs < cleanupMs + 1_000, `B's recovery answered in ${recoverMs} ms, within its ${cleanupMs} ms bound`);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create whose first read fails twice under a 7 s cleanup bound tries it twice again within the bound, for real, and releases the browser no converge answered`, { timeout: 20_000 }, async () => {
		const fake = vendor.vendor();
		const cleanupMs = 7_000;
		const { asked, sleep } = recordedSleep();
		let failed = 0;
		const wrapB = (fetch) => {
			let posted = false;
			return async (input, init = {}) => {
				if (callOf(cloud, input, init).post) posted = true;
				if (requestRead(cloud, posted, input, init) && asked.length < 2) {
					failed++;
					return failing(503);
				}
				return fetch(input, init);
			};
		};
		const optionsB = { cleanupMs, confirm: { polls: 1, intervalMs: 1 }, sleep };
		const { one, a, b, older, newer, recoverMs } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-first-read-twice`), { wrapA: unlistedA(cloud), wrapB, optionsB });
		const kept = okOf(a, "A's create, its converge's listing failed");
		assert.equal(kept.id, newer, "A answers its own, the newer");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.ok(failed >= 2, `B's first read failed twice (${failed} failed calls)`);
		assert.equal(cloud.live(fake, older), false, "the browser B's lost create made, answered by nobody, is released");
		assert.match(b.error.message, /was released, since every newer .* still runs/);
		assert.ok(asked.every((ms) => ms <= cleanupMs / 2), `B's waits (${asked.join(", ")} ms) each within half its ${cleanupMs} ms bound`);
		assert.ok(recoverMs < cleanupMs + 1_000, `B's recovery answered in ${recoverMs} ms, within its ${cleanupMs} ms bound`);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create's browser whose first read already shows a newer one ended is kept at once, with no wait`, async () => {
		const fake = vendor.vendor();
		let slept = 0;
		const sleepB = async () => {
			slept++;
		};
		const { one, a, b, older } = await lostOlder(vendor, cloud, fake, requestOf(`${id}-answered-first`), { sleepB });
		const kept = okOf(a, "A's create");
		assert.equal(kept.id, older, "A's converge answers B's browser, the older");
		assert.equal(slept, 0, "B kept it on its first read, with no wait");
		assert.equal(cloud.releases(fake, older), 0, "no release of the browser A answered was asked");
		assert.match(b.error.message, /left running for that create/);
		okOf(await one.release(kept, "delete"), "release");
	});

	test(`${id}: a lost create whose browser the vendor lists late waits for it no longer than half its cleanup bound, for real`, { timeout: 15_000 }, async () => {
		const fake = vendor.vendor();
		const cleanupMs = 3_000;
		const { asked, sleep } = recordedSleep();
		// The vendor lists the browser only after B's second wait: B's find answers nothing before then.
		let posted = false;
		let lostAt = 0;
		const fetch = async (input, init = {}) => {
			const call = callOf(cloud, input, init);
			if (call.post) {
				posted = true;
				await fake.fetch(input, init);
				lostAt = Date.now();
				// The vendor made the browser, and its reply never comes.
				throw new TypeError("fetch failed");
			}
			if (posted && call.list && asked.length < 2) return rowsAnswer([], { "x-has-more": "false" });
			return fake.fetch(input, init);
		};
		const provider = await vendor.make({ ...fake, fetch }, { cleanupMs, confirm: { polls: 1, intervalMs: 1 }, sleep });
		const b = await provider.create(vendor.spec(), { requestId: requestOf(`${id}-listed-late`) });
		const recoverMs = Date.now() - lostAt;
		assert.equal(b.ok, false, "the lost create");
		const waited = asked.reduce((sum, ms) => sum + ms, 0);
		assert.ok(waited <= cleanupMs / 2, `B waited ${waited} ms in all (${asked.join(", ")}), within half its ${cleanupMs} ms bound`);
		assert.ok(recoverMs < cleanupMs + 900, `B's recovery answered in ${recoverMs} ms, within its ${cleanupMs} ms bound`);
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

for (const [id, cloud] of Object.entries(CLOUD_BROWSERS)) {
	const vendor = VENDORS[id];

	test(`${id}: three creates of one request, the middle one's reply lost and its browser kept by its recovery: the claim's let-go (releaseUnheld) releases that browser, which nothing holds, and never the one the claim holds, another run's or a later epoch's`, async () => {
		const { releaseUnheld } = await import("../dist/index.js");
		const fake = vendor.vendor();
		const run = "run-once";
		const labels = { "agentrun.epoch": "1" };
		const requestId = requestOf(`${id}-three-let-go`);
		// X, B and A each look and find nothing; then X's POST makes the oldest (O), B's the middle (M, its reply lost once A
		// has answered) and A's the newest (N). A's converge answers O and ends N, and B's recovery, which reads a newer one
		// ended, keeps M: nobody holds it.
		const [lookedX, lookedB, lookedA, madeX, madeB, answeredA] = [openable(), openable(), openable(), openable(), openable(), openable()];
		const looked = () => Promise.all([lookedX.opened, lookedB.opened, lookedA.opened]);
		const instance = (onPost) => async (input, init = {}) => (callOf(cloud, input, init).post ? onPost(input, init) : fake.fetch(input, init));
		const x = await vendor.make({
			...fake,
			fetch: instance(async (input, init) => {
				lookedX.open();
				await looked();
				const answer = await fake.fetch(input, init);
				madeX.open();
				return answer;
			}),
		});
		const two = await vendor.make({
			...fake,
			fetch: instance(async (input, init) => {
				lookedB.open();
				await Promise.all([looked(), madeX.opened]);
				await fake.fetch(input, init);
				madeB.open();
				await answeredA.opened;
				// The vendor made B's browser, and its reply never comes.
				throw new TypeError("fetch failed");
			}),
		});
		const one = await vendor.make({
			...fake,
			fetch: instance(async (input, init) => {
				lookedA.open();
				await Promise.all([looked(), madeB.opened]);
				return fake.fetch(input, init);
			}),
		});
		const [made, b, a] = await Promise.all([
			x.create(vendor.spec(labels), { requestId }),
			two.create(vendor.spec(labels), { requestId }),
			one.create(vendor.spec(labels), { requestId }).finally(() => answeredA.open()),
		]);
		const [oldest, middle, newest] = cloud.ids(fake);
		const held = okOf(made, "X's create");
		assert.equal(held.id, oldest, "X answers its own, the oldest");
		assert.equal(okOf(a, "A's create").id, oldest, "A's converge answers the oldest");
		assert.equal(b.ok, false, "B's create, its reply lost");
		assert.equal(cloud.live(fake, newest), false, "A's own, the newest, is released");
		assert.equal(cloud.live(fake, middle), true, "B's recovery kept the middle one: nobody holds it");
		// Beside them: another run's browser at this epoch, and this run's at a later epoch (a later claim's).
		const other = okOf(await x.create(vendor.spec({ "agentrun.run": "run-other", ...labels }), { requestId: requestOf(`${id}-other-run`) }), "another run's create");
		const later = okOf(await x.create(vendor.spec({ "agentrun.epoch": "2" }), { requestId: requestOf(`${id}-later-epoch`) }), "a later epoch's create");

		const swept = okOf(await releaseUnheld(x, run, 1, (info) => info.ref.id === held.id), "the let-go");
		assert.deepEqual(swept.released.map((one) => one.ref.id), [middle], "the let-go released the browser nothing held");
		assert.ok(swept.released[0].createdAt instanceof Date && !Number.isNaN(swept.released[0].createdAt.getTime()), "with when the vendor made it, which a host books its time from");
		assert.deepEqual(swept.held.map((one) => one.id), [oldest], "the claim's browser is held");
		assert.deepEqual(swept.failed, []);
		assert.equal(cloud.live(fake, middle), false, "the middle one has ended");
		assert.equal(cloud.live(fake, oldest), true, "the browser the claim holds still runs");
		assert.equal(cloud.releases(fake, oldest), 0, "no release of the held browser was asked");
		assert.equal(cloud.live(fake, other.id), true, "another run's browser still runs");
		assert.equal(cloud.live(fake, later.id), true, "a later epoch's browser still runs");
		for (const ref of [held, other, later]) okOf(await x.release(ref, "delete"), "release");
	});
}
