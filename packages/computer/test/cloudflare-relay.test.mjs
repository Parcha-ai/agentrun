// The Cloudflare relay template (relays/cloudflare/src/index.ts) under a local fake of the Durable Object and container
// API (developers.cloudflare.com/containers/api/durable-object-container/): no Cloudflare account. Node strips the
// template's types, so the test runs the file Wrangler deploys.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BOX_IMAGE_REPOSITORY } from "../dist/box-image.js";
import { CLOUDFLARE_RELAY_VERSION } from "../dist/descriptors/cloudflare.js";

const relay = await import("../relays/cloudflare/src/index.ts");

const TOKEN = "fake-test-key-relay-not-a-secret";
const BOX = "ghcr.io/parcha-ai/agentrun-box:0123456789ab";
const NAME = "computer-0123456789ab";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-16T10:00:00.000Z");

/** A container as A describes it: start throws while running, monitor settles when it stops, destroy stops it. */
class FakeContainer {
	running = false;
	images = { box: "registry.cloudflare.com/account/agentrun-box@sha256:0" };
	starts = [];
	idle = [];
	#stop;
	#stopped = Promise.resolve();
	start(options) {
		if (this.running) throw new Error("the container is already running");
		this.running = true;
		this.starts.push(options);
		this.#stopped = new Promise((resolve, reject) => (this.#stop = { resolve, reject }));
	}
	monitor() {
		if (this.starts.length === 0) throw new Error("this instance has no container");
		return this.#stopped;
	}
	async destroy() {
		this.exit(0);
	}
	exit(code) {
		if (!this.running) return;
		this.running = false;
		if (code === 0) this.#stop.resolve();
		else this.#stop.reject(Object.assign(new Error(`exit code ${code}`), { exitCode: code }));
	}
	async setInactivityTimeout(ms) {
		this.idle.push(ms);
	}
	/** The object restarted: a monitor() from before never settles (A). */
	forget() {
		if (this.running) this.#stopped = new Promise((resolve, reject) => (this.#stop = { resolve, reject }));
	}
}

/** Storage as a Map, with the one alarm a Durable Object has. */
function fakeStorage() {
	const map = new Map();
	return {
		map,
		alarm: undefined,
		async get(key) {
			return structuredClone(map.get(key));
		},
		async put(key, value) {
			map.set(key, structuredClone(value));
		},
		async delete(key) {
			return map.delete(key);
		},
		async deleteAll() {
			map.clear();
		},
		async list() {
			return new Map([...map].map(([key, value]) => [key, structuredClone(value)]));
		},
		async setAlarm(at) {
			this.alarm = at;
		},
		async deleteAlarm() {
			this.alarm = undefined;
		},
	};
}

/** A namespace of one class: an object per name, made on first use, its storage and container kept across a restart. */
function namespace(Class, env) {
	const places = new Map();
	const place = (name) => {
		if (!places.has(name)) places.set(name, { storage: fakeStorage(), container: new FakeContainer() });
		const one = places.get(name);
		if (one.object === undefined) {
			const state = { storage: one.storage, container: one.container, blockConcurrencyWhile: (run) => (one.ready = run()) };
			one.object = new Class(state, env);
		}
		return one;
	};
	return {
		places,
		place,
		getByName: (name) => ({
			async fetch(request) {
				const one = place(name);
				await one.ready;
				return one.object.fetch(request);
			},
		}),
		restart(name) {
			const one = places.get(name);
			one.object = undefined;
			one.container.forget();
		},
	};
}

function fakeCloudflare({ token = TOKEN } = {}) {
	const env = { BOX_IMAGE: BOX, ...(token === null ? {} : { RELAY_TOKEN: token }) };
	env.COMPUTER = namespace(relay.Computer, env);
	env.INDEX = namespace(relay.Index, env);
	const call = async (method, path, body, auth = `Bearer ${TOKEN}`) => {
		const response = await relay.default.fetch(new Request(`https://agentrun-relay.example.workers.dev${path}`, { method, headers: { authorization: auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
		const text = await response.text();
		return { status: response.status, json: text === "" ? null : JSON.parse(text) };
	};
	return { env, call, computer: (name = NAME) => env.COMPUTER.place(name) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const create = (overrides = {}) => ({ name: NAME, image: BOX, env: { AGENTRUN_ATTACH_TOKEN: `art_${"0".repeat(64)}` }, labels: { "agentrun.computer": "1", run: "r1" }, instance: "standard-3", backstopAt: new Date(T0 + 3 * HOUR).toISOString(), ...overrides });

test("the template's version is the one the provider's descriptor speaks, and its Dockerfile and relay name one box image", async () => {
	assert.equal(relay.RELAY_VERSION, CLOUDFLARE_RELAY_VERSION);
	const config = JSON.parse(await readFile(new URL("../relays/cloudflare/wrangler.json", import.meta.url), "utf8"));
	const built = config.containers[0].images.box.build_vars.BOX_IMAGE;
	assert.equal(config.vars.BOX_IMAGE, built);
	assert.match(built, new RegExp(`^${BOX_IMAGE_REPOSITORY.replaceAll(".", "\\.")}:[0-9a-f]{12}$`));
	assert.equal(await readFile(new URL("../relays/cloudflare/Dockerfile", import.meta.url), "utf8"), "ARG BOX_IMAGE\nFROM ${BOX_IMAGE}\n");
});

test("every route refuses a relay with no RELAY_TOKEN, and a token that isn't its own; health answers the version and image", async () => {
	const unset = fakeCloudflare({ token: null });
	const refused = await unset.call("GET", "/v1/health");
	assert.equal(refused.status, 503);
	assert.match(refused.json.error, /no RELAY_TOKEN: set one with `npx wrangler secret put RELAY_TOKEN`/);
	assert.equal((await unset.call("GET", "/v1/health", undefined, "Bearer ")).status, 503);
	const cf = fakeCloudflare();
	for (const auth of ["", `Bearer ${TOKEN}x`, TOKEN]) assert.equal((await cf.call("GET", "/v1/health", undefined, auth)).status, 401, auth);
	assert.deepEqual(await cf.call("GET", "/v1/health"), { status: 200, json: { version: CLOUDFLARE_RELAY_VERSION, image: BOX } });
	assert.equal((await cf.call("POST", "/v1/health")).status, 404);
});

test("create starts the box with the boot env and agentrun-dial, keeps it six hours idle, and is idempotent by name", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: T0 });
	const cf = fakeCloudflare();
	const made = await cf.call("POST", "/v1/computers", create());
	assert.deepEqual(made, { status: 201, json: { name: NAME, labels: { "agentrun.computer": "1", run: "r1" }, image: BOX, createdAt: "2026-11-16T10:00:00.000Z", state: "running" } });
	const { container, storage } = cf.computer();
	assert.deepEqual(container.starts, [{ image: container.images.box, env: { AGENTRUN_ATTACH_TOKEN: `art_${"0".repeat(64)}` }, entrypoint: ["/usr/local/bin/agentrun-dial"], enableInternet: true, instance: "standard-3" }]);
	assert.deepEqual(container.idle, [6 * HOUR]);
	assert.equal(storage.alarm, T0 + HOUR);
	// The same name again: the running computer's row, and no second start.
	const again = await cf.call("POST", "/v1/computers", create({ env: {} }));
	assert.deepEqual(again, { status: 200, json: made.json });
	assert.equal(container.starts.length, 1);
	// A body the relay refuses starts nothing.
	for (const [body, words] of [
		[create({ name: "computer-x" }), /^name must be computer-<12 hex digits>$/],
		[create({ image: "ubuntu" }), /^this relay starts ghcr\.io\/parcha-ai\/agentrun-box:0123456789ab alone, not "ubuntu": ask for it, or redeploy the relay FROM the image you want$/],
		[create({ env: { A: 1 } }), /^env and labels must map names to strings$/],
		[create({ instance: "standard-9" }), /^instance must be one of lite, standard-1, standard-2, standard-3, standard-4$/],
		[create({ backstopAt: "soon" }), /^backstopAt must be an ISO time$/],
	]) {
		const refused = await cf.call("POST", "/v1/computers", body);
		assert.equal(refused.status, 422);
		assert.match(refused.json.error, words);
	}
	assert.equal(cf.env.COMPUTER.places.size, 1);
});

test("get reads the row and the container: a platform stop is gone with why, also after the object restarts", async () => {
	const cf = fakeCloudflare();
	assert.equal((await cf.call("GET", `/v1/computers/${NAME}`)).status, 404);
	assert.equal((await cf.call("GET", "/v1/computers/..%2Fx")).status, 404);
	await cf.call("POST", "/v1/computers", create());
	assert.equal((await cf.call("GET", `/v1/computers/${NAME}`)).json.state, "running");
	cf.computer().container.exit(137);
	await settle();
	const gone = await cf.call("GET", `/v1/computers/${NAME}`);
	assert.deepEqual([gone.json.state, gone.json.why], ["gone", "it stopped: exit code 137"]);
	assert.deepEqual((await cf.call("GET", "/v1/computers?run=r1")).json.computers.map(({ state }) => state), ["gone"]);
	// monitor() doesn't survive a restart: the new object watches again, and a container that stopped meanwhile is gone.
	const other = "computer-00000000000b";
	await cf.call("POST", "/v1/computers", create({ name: other }));
	cf.env.COMPUTER.restart(other);
	cf.computer(other);
	cf.computer(other).container.exit(0);
	await settle();
	assert.deepEqual((await cf.call("GET", `/v1/computers/${other}`)).json.why, "its main process exited");
});

test("list goes through the index, by every label asked for", async () => {
	const cf = fakeCloudflare();
	await cf.call("POST", "/v1/computers", create());
	await cf.call("POST", "/v1/computers", create({ name: "computer-00000000000b", labels: { "agentrun.computer": "1", run: "r2" } }));
	const names = async (query) => (await cf.call("GET", `/v1/computers${query}`)).json.computers.map(({ name }) => name);
	assert.deepEqual(await names(""), [NAME, "computer-00000000000b"]);
	assert.deepEqual(await names("?agentrun.computer=1&run=r2"), ["computer-00000000000b"]);
	assert.deepEqual(await names("?run=r3"), []);
	const [row] = (await cf.call("GET", "/v1/computers?run=r1")).json.computers;
	assert.deepEqual(row, { name: NAME, labels: { "agentrun.computer": "1", run: "r1" }, createdAt: row.createdAt, state: "running" });
});

test("delete destroys the container and drops the row, its alarm and its index entry; one already gone is fine", async () => {
	const cf = fakeCloudflare();
	await cf.call("POST", "/v1/computers", create());
	const { container, storage } = cf.computer();
	assert.equal((await cf.call("DELETE", `/v1/computers/${NAME}`)).status, 204);
	await settle();
	assert.equal(container.running, false);
	assert.deepEqual([storage.map.size, storage.alarm], [0, undefined]);
	assert.equal((await cf.call("GET", `/v1/computers/${NAME}`)).status, 404);
	assert.deepEqual((await cf.call("GET", "/v1/computers")).json.computers, []);
	assert.equal((await cf.call("DELETE", `/v1/computers/${NAME}`)).status, 204);
	// A name deleted is a name a create may start again.
	assert.equal((await cf.call("POST", "/v1/computers", create())).status, 201);
	assert.equal(container.starts.length, 2);
});

test("the alarm sets the idle timeout again each hour, and at backstopAt destroys the container and drops its row", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: T0 });
	const cf = fakeCloudflare();
	await cf.call("POST", "/v1/computers", create({ backstopAt: new Date(T0 + 90 * 60_000).toISOString() }));
	const one = cf.computer();
	t.mock.timers.setTime(T0 + HOUR);
	await one.object.alarm();
	assert.deepEqual(one.container.idle, [6 * HOUR, 6 * HOUR]);
	assert.equal(one.storage.alarm, T0 + 90 * 60_000, "never past backstopAt");
	t.mock.timers.setTime(T0 + 90 * 60_000);
	cf.env.COMPUTER.restart(NAME);
	await cf.env.COMPUTER.place(NAME).ready;
	await cf.computer().object.alarm();
	await settle();
	assert.equal(one.container.running, false);
	assert.deepEqual([one.storage.map.size, one.storage.alarm], [0, undefined]);
	assert.deepEqual((await cf.call("GET", "/v1/computers")).json.computers, []);
	await cf.computer().object.alarm();
});
