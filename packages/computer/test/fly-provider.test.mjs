// FlyProvider's host on a fake Machines API (the REST shapes of docs.fly.io/machines/api/machines-resource, as a fetch):
// create's body (the boot env, the labels as metadata, restart "no" and auto_destroy), get and list with their states,
// the metadata filter, a forced delete, extend's one metadata key, and the error codes in Fly's words. The adapter's dial
// lifecycle is tested once over the fake dial host (hosted-dial.test.mjs), and Fly's desktop once through it to its X
// server, on a Machines API that keeps what it makes (bootDial); Fly's own is proven live, from
// packages/serve/scripts/dial-conformance.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AttachHub, MemoryMachineTokens } from "../dist/index.js";
import { bootDial, desktopOverDial, dialServer } from "./fake-dial-host.mjs";
import { codeOfError } from "../dist/hosted/process.js";
import * as registry from "../dist/providers.js";

const { FlyProvider, create } = await import("../dist/fly.js");
const flyModule = await import("../dist/conformance/fly.js");

const TOKEN = "fake-test-key-fly-not-a-secret";
const APP = "agentrun-conformance";
const BASE = `https://api.machines.dev/v1/apps/${APP}/machines`;
const CTX = { timeoutMs: 10_000 };
const NAME = "computer-0123456789ab";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME, "agentrun.computer.deadline": "2026-11-16T12:00:00.000Z" };
const BOOT = { AGENTRUN_ATTACH_URL: "wss://agentrun.example.com/v2/computers/attach", AGENTRUN_ATTACH_TOKEN: `art_${"0".repeat(64)}` };

/** A Fly machine as the API answers one (M, "Machine properties"). */
const flyMachine = (id, state, metadata = LABELS, extra = {}) => ({
	id,
	name: NAME,
	state,
	region: "ord",
	instance_id: "01H3JK5BFPFE0XMFZ8T8JN0AD1",
	private_ip: "fdaa:0:3b99:a7b:7f:1d2c:a1b3:2",
	image_ref: { registry: "ghcr.io", repository: "parcha-ai/agentrun-box", tag: "0123456789ab" },
	config: { image: "ghcr.io/parcha-ai/agentrun-box:0123456789ab", env: {}, metadata, auto_destroy: true, restart: { policy: "no" } },
	created_at: "2026-11-16T10:00:00Z",
	updated_at: "2026-11-16T10:00:01Z",
	...extra,
});

/** A fetch that answers each call from `answer(method, url, body)` ({ status, json }) and keeps every call. */
function fakeFly(answer) {
	const calls = [];
	const fetch = async (url, init) => {
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		calls.push({ method: init.method, url: String(url), headers: init.headers, body });
		const { status = 200, json } = answer(init.method, new URL(url), body) ?? { status: 404, json: { error: "not found" } };
		return new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
	};
	return { calls, fetch };
}

const provider = (fly, options = {}) => new FlyProvider({ apiToken: TOKEN, app: APP, fetch: fly.fetch, ...options });

test("create posts the machine's name, the box image, the boot env as config.env and the labels as config.metadata, with no restart and auto_destroy", async () => {
	const fly = fakeFly((method, url) => (method === "POST" && url.href === BASE ? { json: flyMachine("3d8d9e3a5e4d89", "created") } : undefined));
	const made = await provider(fly).host.create({ name: NAME, image: "ghcr.io/parcha-ai/agentrun-box:0123456789ab", labels: LABELS, lifetimeMs: 600_000, backstopAt: "2026-11-17T10:05:00.000Z", egress: true, boot: { env: BOOT } }, CTX);
	assert.deepEqual(made, { id: "3d8d9e3a5e4d89" });
	const [call] = fly.calls;
	assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
	assert.deepEqual(call.body, {
		name: NAME,
		config: {
			image: "ghcr.io/parcha-ai/agentrun-box:0123456789ab",
			env: BOOT,
			metadata: LABELS,
			guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
			restart: { policy: "no" },
			auto_destroy: true,
		},
	});
});

test("create takes the spec's size, and a request with no boot env makes nothing", async () => {
	const fly = fakeFly(() => ({ json: flyMachine("3d8d9e3a5e4d89", "created") }));
	const { host } = provider(fly);
	await host.create({ name: NAME, image: "img", labels: LABELS, lifetimeMs: 1, backstopAt: "", egress: true, boot: { env: BOOT }, cpus: 4, memoryMb: 2048 }, CTX);
	assert.deepEqual(fly.calls[0].body.config.guest, { cpu_kind: "shared", cpus: 4, memory_mb: 2048 });
	await assert.rejects(host.create({ name: NAME, image: "img", labels: LABELS, lifetimeMs: 1, backstopAt: "", egress: true }, CTX), (error) => error.code === "invalid" && /no boot env/.test(error.message));
	assert.equal(fly.calls.length, 1);
});

test("a size with CPUs and no memory gets the default memory, or the most its shared CPUs take when that is less: one CPU's 2048 MiB", async () => {
	const fly = fakeFly(() => ({ json: flyMachine("3d8d9e3a5e4d89", "created") }));
	const { host } = provider(fly);
	const request = { name: NAME, image: "img", labels: LABELS, lifetimeMs: 1, backstopAt: "", egress: true, boot: { env: BOOT } };
	for (const cpus of [1, 2, 8]) await host.create({ ...request, cpus }, CTX);
	assert.deepEqual(fly.calls.map(({ body }) => body.config.guest.memory_mb), [2048, 4096, 4096]);
	assert.deepEqual(host.check({ cpus: 1 }), []);
});

test("get reads each Fly state as the adapter's and the labels from metadata, and nothing of the machine's name or image; a destroyed machine is none", async () => {
	const states = { started: "running", created: "starting", starting: "starting", replacing: "starting", stopped: "stopped", suspended: "stopped", archived: "stopped", destroying: "gone", failed: "gone", launch_failed: "gone" };
	for (const [state, want] of Object.entries(states)) {
		const fly = fakeFly((method, url) => (method === "GET" && url.href === `${BASE}/3d8d9e3a5e4d89` ? { json: flyMachine("3d8d9e3a5e4d89", state) } : undefined));
		const machine = await provider(fly).host.get("3d8d9e3a5e4d89", CTX);
		assert.equal(machine.state, want, state);
		assert.deepEqual(machine.labels, LABELS);
		assert.deepEqual(Object.keys(machine).filter((key) => key === "name" || key === "image"), []);
		assert.equal(machine.createdAt.toISOString(), "2026-11-16T10:00:00.000Z");
		if (state === "failed") assert.match(machine.why, /could not start/);
	}
	for (const state of ["destroyed", "replaced", "migrated"]) {
		assert.equal(await provider(fakeFly(() => ({ json: flyMachine("3d8d9e3a5e4d89", state) }))).host.get("3d8d9e3a5e4d89", CTX), undefined, state);
	}
	const odd = await provider(fakeFly(() => ({ json: flyMachine("3d8d9e3a5e4d89", "levitating") }))).host.get("3d8d9e3a5e4d89", CTX);
	assert.deepEqual([odd.state, odd.why], ["gone", 'Fly reads the machine\'s state "levitating", which this provider does not know']);
	// A machine whose host isn't ok answers only incomplete_config.
	const partial = await provider(fakeFly(() => ({ json: { ...flyMachine("3d8d9e3a5e4d89", "started"), config: undefined, incomplete_config: { metadata: { a: "b" } } } }))).host.get("3d8d9e3a5e4d89", CTX);
	assert.deepEqual(partial.labels, { a: "b" });
	await assert.rejects(provider(fakeFly(() => undefined)).host.get("../apps", CTX), (error) => error.code === "not_found");
});

test("list asks for the labels as metadata filters, every one, and leaves destroyed machines out", async () => {
	const fly = fakeFly((method, url) =>
		method === "GET" && url.pathname === `/v1/apps/${APP}/machines` ? { json: [flyMachine("a1", "started"), flyMachine("a2", "destroyed"), flyMachine("a3", "stopped")] } : undefined,
	);
	const machines = await provider(fly).host.list({ "agentrun.computer": "1", "agentrun.computer.run": "run 1" }, CTX);
	assert.deepEqual(machines.map(({ id, state }) => [id, state]), [["a1", "running"], ["a3", "stopped"]]);
	const asked = new URL(fly.calls[0].url).searchParams;
	assert.deepEqual([...asked], [["metadata.agentrun.computer", "1"], ["metadata.agentrun.computer.run", "run 1"]]);
	await assert.rejects(provider(fakeFly(() => ({ json: { machines: [] } }))).host.list({}, CTX), /answered no list/);
});

test("delete forces the machine's stop; extend posts the deadline label alone", async () => {
	const fly = fakeFly((method) => (method === "DELETE" ? { json: { ok: true } } : { status: 204 }));
	const { host } = provider(fly);
	await host.delete("3d8d9e3a5e4d89", CTX);
	await host.extend("3d8d9e3a5e4d89", new Date("2026-11-16T13:00:00.000Z"), CTX);
	assert.deepEqual(
		fly.calls.map(({ method, url, body }) => [method, url, body]),
		[
			["DELETE", `${BASE}/3d8d9e3a5e4d89?force=true`, undefined],
			["POST", `${BASE}/3d8d9e3a5e4d89/metadata/agentrun.computer.deadline`, { value: "2026-11-16T13:00:00.000Z" }],
		],
	);
});

test("Fly's errors are codes in Fly's words, never the token; a 429 create is sent again, a create with no answer never", async () => {
	for (const [status, code] of [[401, "denied"], [404, "not_found"], [422, "invalid"], [409, "exists"]]) {
		const fly = fakeFly(() => ({ status, json: { error: "app agentrun-conformance said no", message: "in words" } }));
		const error = await provider(fly).host.create({ name: NAME, image: "img", labels: {}, lifetimeMs: 1, backstopAt: "", egress: true, boot: { env: BOOT } }, CTX).catch((caught) => caught);
		assert.equal(codeOfError(provider(fly).host, error), code, String(status));
		assert.match(error.message, new RegExp(`^POST /v1/apps/${APP}/machines answered ${status}: app agentrun-conformance said no: in words$`));
		assert.equal(error.message.includes(TOKEN), false);
	}
	let posts = 0;
	const busy = fakeFly(() => (++posts === 1 ? { status: 429, json: { error: "rate limited" } } : { json: flyMachine("3d8d9e3a5e4d89", "created") }));
	assert.deepEqual(await provider(busy).host.create({ name: NAME, image: "img", labels: {}, lifetimeMs: 1, backstopAt: "", egress: true, boot: { env: BOOT } }, CTX), { id: "3d8d9e3a5e4d89" });
	assert.equal(posts, 2);
	let tries = 0;
	const silent = { fetch: async () => (tries++, Promise.reject(new TypeError("fetch failed"))) };
	await assert.rejects(provider(silent).host.create({ name: NAME, image: "img", labels: {}, lifetimeMs: 1, backstopAt: "", egress: true, boot: { env: BOOT } }, CTX));
	assert.equal(tries, 1, "a create that got no answer may have made a machine: never sent again");
});

test("the provider dials: kind linux, no exec or upload, a synced folder alone, the box image; a server with no public address calls Fly for nothing", async () => {
	const fly = fakeFly(() => undefined);
	const flyProvider = provider(fly, { dial: { tokens: new MemoryMachineTokens(), hub: new AttachHub() } });
	assert.equal(flyProvider.host.facts.connect, "dial");
	assert.equal(flyProvider.host.exec, undefined);
	assert.equal(flyProvider.host.upload, undefined);
	const caps = flyProvider.capabilities();
	assert.deepEqual([caps.kind, caps.isolation, caps.mount, caps.network], ["linux", "microvm", ["sync"], ["none", "open", "allow"]]);
	assert.match((await flyProvider.prepareImage()).value, /^ghcr\.io\/parcha-ai\/agentrun-box:[0-9a-f]{12}$/);
	const refused = await flyProvider.create({ image: "img", lifetimeMs: 600_000, network: "none" }, { requestId: "fly-no-address" });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /^Fly Machines machines dial this server, and it has no public https address/);
	assert.deepEqual(fly.calls, []);
});

test("kind desktop: the desktop's groups and the window manager, and DISPLAY beside the boot env Fly posts as config.env, for init; kind linux, the default, posts none", async () => {
	for (const kind of ["desktop", "linux", undefined]) {
		// Fly refuses the machine: what it was asked is all this reads. The daemon is any file (its sha256 goes in the env).
		const fly = fakeFly((method, url) => (method === "POST" && url.href === BASE ? { status: 422, json: { error: "refused in a test" } } : method === "GET" ? { json: [] } : undefined));
		const dial = { url: "http://127.0.0.1:8080", tokens: new MemoryMachineTokens(), hub: new AttachHub() };
		const made = provider(fly, { ...(kind === undefined ? {} : { kind }), dial, daemonPath: fileURLToPath(import.meta.url) });
		const caps = made.capabilities();
		assert.equal(caps.kind, kind ?? "linux");
		assert.deepEqual(caps.groups, kind === "desktop" ? ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "apps"] : ["exec", "files", "processes"]);
		assert.equal(made.host.facts.windowManager, true, "the box image has xfwm4");
		const result = await made.create({ image: "ghcr.io/parcha-ai/agentrun-box:0123456789ab", lifetimeMs: 600_000, network: "none" }, { requestId: `fly-${kind}` });
		assert.equal(result.error?.code, "invalid", JSON.stringify(result));
		const { env, guest } = fly.calls.find(({ method }) => method === "POST").body.config;
		assert.deepEqual(Object.keys(env).sort(), [...["AGENTRUN_ATTACH_TOKEN", "AGENTRUN_ATTACH_URL", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_DAEMON_URL", "AGENTRUN_INIT_ARGS"], ...(kind === "desktop" ? ["DISPLAY"] : [])].sort(), String(kind));
		assert.equal(env.DISPLAY, kind === "desktop" ? ":0" : undefined);
		assert.deepEqual(guest, { cpu_kind: "shared", cpus: 2, memory_mb: 4096 }, "a desktop's size is the sandbox's");
	}
});

test("Fly's desktop configuration, as serve builds it, makes a desktop over dial: the machine boots from config.env, dials, and its X server and xfwm4 start over that socket", async () => {
	const dial = dialServer();
	const daemonPath = fileURLToPath(import.meta.url);
	const machines = new Map();
	let booted;
	// A Machines API that keeps what it makes: the machine boots from the config.env it was posted (bootDial).
	const fly = fakeFly((method, url, body) => {
		const id = url.pathname.split("/")[5];
		if (method === "POST" && url.href === BASE) {
			const machine = flyMachine(`m${machines.size + 1}`, "started", body.config.metadata, { name: body.name, config: body.config });
			machines.set(machine.id, machine);
			booted = bootDial(body.config.env, dial, { daemon: readFileSync(daemonPath) });
			return { json: machine };
		}
		if (method === "GET" && id === undefined) {
			const wanted = [...url.searchParams].map(([key, value]) => [key.replace(/^metadata\./, ""), value]);
			return { json: [...machines.values()].filter(({ config }) => wanted.every(([key, value]) => config.metadata[key] === value)) };
		}
		if (method === "GET" && machines.has(id)) return { json: machines.get(id) };
		if (method === "DELETE" && machines.has(id)) {
			machines.get(id).state = "destroyed";
			return { json: { ok: true } };
		}
		return undefined;
	});
	const { options } = registry.descriptorOf("fly").capabilities.find(({ kind }) => kind === "desktop");
	const made = provider(fly, { ...options, dial, daemonPath });
	assert.equal(made.capabilities().kind, "desktop");
	await desktopOverDial(made, dial, () => booted, { image: "ghcr.io/parcha-ai/agentrun-box:0123456789ab", lifetimeMs: 600_000, network: "none" });
	assert.equal([...machines.values()][0].state, "destroyed");
});

test("check holds a size to Fly's shared CPUs and their memory, and an image to a registry path", () => {
	const { host } = provider(fakeFly(() => undefined));
	assert.deepEqual(host.check({ cpus: 2, memoryMb: 4096, image: "ghcr.io/parcha-ai/agentrun-box:0123456789ab" }), []);
	assert.deepEqual(host.check({ cpus: 3 }).map(({ field }) => field), ["cpus"]);
	assert.deepEqual(host.check({ cpus: 1, memoryMb: 4096 }).map(({ message }) => message), ["a Fly machine of 1 shared CPUs has a multiple of 256 MiB from 256 to 2048"]);
	assert.deepEqual(host.check({ memoryMb: 1000 }).map(({ field }) => field), ["memoryMb"]);
	assert.deepEqual(host.check({ image: "--privileged" }).map(({ field }) => field), ["image"]);
});

test("the constructor refuses a missing token, an app that is no Fly app name, and a fetch that is no function, never echoing the token", () => {
	assert.throws(() => new FlyProvider({ app: APP }), /options.apiToken, a Fly API token, is required/);
	assert.throws(() => new FlyProvider({ apiToken: TOKEN, app: "Not An App" }), (error) => /options.app is the name of the Fly app/.test(error.message) && !error.message.includes(TOKEN));
	assert.throws(() => new FlyProvider({ apiToken: TOKEN, app: APP, fetch: "no" }), /options.fetch must be a function/);
	assert.ok(create({ apiToken: TOKEN, app: APP }) instanceof FlyProvider);
});

test("fly is in the registry, and its conformance module reads COMPUTER_FLY_* alone and refuses a dialKit off the public server", async () => {
	assert.ok(registry.providerIds.includes("fly"));
	assert.equal((await registry.providerModule("fly")).create, create);
	assert.deepEqual(flyModule.ENV, { token: "COMPUTER_FLY_API_TOKEN", app: "COMPUTER_FLY_APP" });
	assert.throws(() => flyModule.settingsFromEnv({ FLY_API_TOKEN: TOKEN, COMPUTER_FLY_APP: APP }), /needs COMPUTER_FLY_API_TOKEN and COMPUTER_FLY_APP/);
	const env = { COMPUTER_FLY_API_TOKEN: TOKEN, COMPUTER_FLY_APP: APP };
	assert.equal(flyModule.createProvider({ env }).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal(flyModule.sweepScope({ env }), `the Fly app ${APP}`);
	assert.equal(flyModule.conformanceImage(), (await provider(fakeFly(() => undefined)).prepareImage()).value);
	assert.throws(() => flyModule.dialKit({ env }), /^Error: a Fly machine dials the server that minted its token, and this run has no public server: run Fly's Core with packages\/serve\/scripts\/dial-conformance\.mjs --provider fly/);
});
