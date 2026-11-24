// CloudflareProvider's host on a fake relay (the routes of relays/cloudflare/src/index.ts, as a fetch): create's body
// (the boot env, the labels, the instance its size picks, backstopAt, and nothing to run), get and list, delete, the
// relay's version and image read from /v1/health, the size refusals, and the error codes in the relay's words. The
// adapter's dial lifecycle is tested once over the fake dial host (hosted-dial.test.mjs), and Cloudflare's desktop once
// through it to its X server, on a relay that keeps what it makes (bootDial); Cloudflare's is proven live, from
// packages/serve/scripts/dial-conformance.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AttachHub, MemoryMachineTokens } from "../dist/index.js";
import { bootDial, desktopOverDial, dialServer } from "./fake-dial-host.mjs";
import { codeOfError } from "../dist/hosted/process.js";
import * as registry from "../dist/providers.js";

const { CloudflareProvider, create } = await import("../dist/cloudflare.js");
const { CLOUDFLARE_RELAY_VERSION } = await import("../dist/descriptors/cloudflare.js");
const cloudflareModule = await import("../dist/conformance/cloudflare.js");

const TOKEN = "fake-test-key-relay-not-a-secret";
const RELAY = "https://agentrun-relay.example.workers.dev";
const BOX = "ghcr.io/parcha-ai/agentrun-box:0123456789ab";
const CTX = { timeoutMs: 10_000 };
const NAME = "computer-0123456789ab";
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME };
const BOOT = { AGENTRUN_ATTACH_URL: "wss://agentrun.example.com/v2/computers/attach", AGENTRUN_ATTACH_TOKEN: `art_${"0".repeat(64)}` };
const REQUEST = { name: NAME, image: BOX, labels: LABELS, lifetimeMs: 600_000, backstopAt: "2026-11-17T10:05:00.000Z", egress: true, boot: { env: BOOT } };
const row = (state, extra = {}) => ({ name: NAME, labels: LABELS, image: BOX, createdAt: "2026-11-16T10:00:00.000Z", state, ...extra });

/** A fetch that answers each call from `answer(method, url, body)` ({ status, json }) and keeps every call. */
function fakeRelay(answer) {
	const calls = [];
	const fetch = async (url, init) => {
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		calls.push({ method: init.method, url: String(url), headers: init.headers, body });
		const { status = 200, json } = answer(init.method, new URL(url), body) ?? { status: 404, json: { error: "no such computer" } };
		return new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
	};
	return { calls, fetch };
}

const health = (version = CLOUDFLARE_RELAY_VERSION, image = BOX) => (method, url) => (url.pathname === "/v1/health" ? { json: { version, image } } : method === "GET" && url.pathname === "/v1/computers" ? { json: { computers: [] } } : undefined);
const provider = (relay, options = {}) => new CloudflareProvider({ relayUrl: RELAY, relayToken: TOKEN, fetch: relay.fetch, ...options });

test("create posts the name, the image, the boot env, the labels, the instance and backstopAt, with the relay's token, and runs nothing", async () => {
	const relay = fakeRelay((method, url) => (method === "POST" && url.href === `${RELAY}/v1/computers` ? { status: 201, json: row("running") } : undefined));
	assert.deepEqual(await provider(relay).host.create(REQUEST, CTX), { id: NAME });
	const [call] = relay.calls;
	assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
	assert.deepEqual(call.body, { name: NAME, image: BOX, env: BOOT, labels: LABELS, instance: "standard-3", backstopAt: "2026-11-17T10:05:00.000Z" });
	await assert.rejects(provider(relay).host.create({ ...REQUEST, boot: undefined }, CTX), (error) => error.code === "invalid" && /no boot env/.test(error.message));
	assert.equal(relay.calls.length, 1);
});

test("the size picks the smallest instance that holds it; past standard-4 is refused in words", async () => {
	const relay = fakeRelay(() => ({ status: 201, json: row("starting") }));
	const { host } = provider(relay);
	for (const [cpus, memoryMb, instance] of [[1, 1024, "standard-2"], [2, 8192, "standard-3"], [1, 8192, "standard-3"], [4, 4096, "standard-4"], [undefined, 12288, "standard-4"]]) {
		await host.create({ ...REQUEST, cpus, memoryMb }, CTX);
		assert.equal(relay.calls.at(-1).body.instance, instance, `${cpus} CPUs, ${memoryMb} MiB`);
	}
	assert.deepEqual(host.check({ cpus: 4, memoryMb: 12288 }), []);
	assert.deepEqual(host.check({ cpus: 8 }), [{ field: "cpus", message: "a Cloudflare container has at most 4 vCPUs and 12288 MiB (standard-4, its largest): ask for less" }]);
	assert.deepEqual(host.check({ memoryMb: 16384 }).map(({ field }) => field), ["memoryMb"]);
	assert.deepEqual(host.check({ cpus: 0 }).map(({ field }) => field), ["cpus"]);
});

test("get reads the relay's row: its state, labels, image, creation and why; a computer the relay has none of is not_found", async () => {
	for (const state of ["starting", "running", "gone"]) {
		const relay = fakeRelay((method, url) => (method === "GET" && url.href === `${RELAY}/v1/computers/${NAME}` ? { json: row(state, state === "gone" ? { why: "it stopped: exit code 137" } : {}) } : undefined));
		const machine = await provider(relay).host.get(NAME, CTX);
		assert.deepEqual(machine, { id: NAME, labels: LABELS, image: BOX, state, createdAt: new Date("2026-11-16T10:00:00.000Z"), ...(state === "gone" ? { why: "it stopped: exit code 137" } : {}) });
	}
	await assert.rejects(provider(fakeRelay(() => undefined)).host.get(NAME, CTX), (error) => error.code === "not_found");
	await assert.rejects(provider(fakeRelay(() => undefined)).host.get("../v1/health", CTX), (error) => error.code === "not_found");
});

test("list asks the relay's index by the labels; delete is the relay's DELETE", async () => {
	const relay = fakeRelay((method, url) => (method === "GET" ? { json: { computers: [row("running"), { ...row("gone"), name: "computer-00000000000b" }] } } : { status: 204 }));
	const { host } = provider(relay);
	const machines = await host.list({ "agentrun.computer": "1", "agentrun.computer.run": "run 1" }, CTX);
	assert.deepEqual(machines.map(({ id, state }) => [id, state]), [[NAME, "running"], ["computer-00000000000b", "gone"]]);
	assert.deepEqual([...new URL(relay.calls[0].url).searchParams], [["agentrun.computer", "1"], ["agentrun.computer.run", "run 1"]]);
	await host.delete(NAME, CTX);
	assert.deepEqual([relay.calls[1].method, relay.calls[1].url], ["DELETE", `${RELAY}/v1/computers/${NAME}`]);
	await assert.rejects(provider(fakeRelay(() => ({ json: [] }))).host.list({}, CTX), /answered no computers/);
});

test("the relay's errors are codes in its words, never the token; a create that got no answer is never sent again", async () => {
	for (const [status, code] of [[401, "denied"], [422, "invalid"], [503, "vendor"], [429, "limit"]]) {
		const relay = fakeRelay(() => ({ status, json: { error: "the relay said no" } }));
		const error = await provider(relay).host.create(REQUEST, CTX).catch((caught) => caught);
		assert.equal(codeOfError(provider(relay).host, error), code, String(status));
		assert.match(error.message, new RegExp(`^POST /v1/computers answered ${status}: the relay said no$`));
		assert.equal(error.message.includes(TOKEN), false);
	}
	let tries = 0;
	const silent = { fetch: async () => (tries++, Promise.reject(new TypeError("fetch failed"))) };
	await assert.rejects(provider(silent).host.create(REQUEST, CTX));
	assert.equal(tries, 1);
});

test("a create answered 500, 502 or 503 is sent again with the same name, which the relay answers with the first's row", async () => {
	const answers = [{ status: 500 }, { status: 502 }, { status: 503, json: { error: "the relay failed: overloaded" } }, { status: 201, json: row("starting") }];
	const relay = fakeRelay(() => answers.shift());
	assert.deepEqual(await provider(relay).host.create(REQUEST, CTX), { id: NAME });
	assert.equal(relay.calls.length, 4);
	assert.equal(new Set(relay.calls.map(({ body }) => JSON.stringify(body))).size, 1);
});

test("testConnection and prepareImage read /v1/health: a relay of another version is refused with how to redeploy", async () => {
	const good = provider(fakeRelay(health()));
	assert.deepEqual(await good.prepareImage(), { ok: true, value: BOX });
	assert.deepEqual(await good.testConnection(), { ok: true, value: { detail: "Cloudflare answered: 0 computers of this provider" } });
	const stale = provider(fakeRelay(health(CLOUDFLARE_RELAY_VERSION + 1)));
	for (const answered of [await stale.testConnection(), await stale.prepareImage()]) {
		assert.equal(answered.error.code, "refused");
		assert.equal(
			answered.error.message,
			`the relay at ${RELAY} speaks version ${CLOUDFLARE_RELAY_VERSION + 1}, and this server speaks ${CLOUDFLARE_RELAY_VERSION}: redeploy it from this release's packages/computer/relays/cloudflare (npx wrangler deploy)`,
		);
	}
	const refused = await provider(fakeRelay(() => ({ status: 401, json: { error: "the bearer token is not this relay's RELAY_TOKEN" } }))).testConnection();
	assert.deepEqual(refused.error, { code: "unauthorized", message: "GET /v1/health answered 401: the bearer token is not this relay's RELAY_TOKEN" });
});

test("the provider dials: kind linux, a microVM, no exec or upload, a synced folder alone (agentrun-dial makes /workspace); a server with no public address calls the relay for nothing", async () => {
	const relay = fakeRelay(() => undefined);
	const made = provider(relay, { dial: { tokens: new MemoryMachineTokens(), hub: new AttachHub() } });
	assert.deepEqual([made.host.facts.connect, made.host.exec, made.host.upload, made.host.extend], ["dial", undefined, undefined, undefined]);
	const caps = made.capabilities();
	assert.deepEqual([caps.kind, caps.isolation, caps.mount, caps.network, caps.gpu], ["linux", "microvm", ["sync"], ["none", "open", "allow"], undefined]);
	const refused = await made.create({ image: BOX, lifetimeMs: 600_000, network: "none" }, { requestId: "cf-no-address" });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /^Cloudflare machines dial this server, and it has no public https address/);
	assert.deepEqual(relay.calls, []);
});

test("kind desktop: the desktop's groups and the window manager, and DISPLAY beside the boot env the relay is given, for init, on standard-3; kind linux, the default, gets none", async () => {
	for (const kind of ["desktop", "linux", undefined]) {
		// The relay refuses the container: what it was asked is all this reads. The daemon is any file (its sha256 goes in the env).
		const relay = fakeRelay((method, url) => (method === "POST" ? { status: 400, json: { error: "refused in a test" } } : health()(method, url)));
		const dial = { url: "http://127.0.0.1:8080", tokens: new MemoryMachineTokens(), hub: new AttachHub() };
		const made = provider(relay, { ...(kind === undefined ? {} : { kind }), dial, daemonPath: fileURLToPath(import.meta.url) });
		const caps = made.capabilities();
		assert.equal(caps.kind, kind ?? "linux");
		assert.deepEqual(caps.groups, kind === "desktop" ? ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "apps"] : ["exec", "files", "processes"]);
		assert.equal(made.host.facts.windowManager, true, "the relay's image is FROM the box image, which has xfwm4");
		const result = await made.create({ image: BOX, lifetimeMs: 600_000, network: "none" }, { requestId: `cf-${kind}` });
		assert.equal(result.error?.code, "invalid", JSON.stringify(result));
		const { env, instance } = relay.calls.find(({ method }) => method === "POST").body;
		assert.deepEqual(Object.keys(env).sort(), [...["AGENTRUN_ATTACH_TOKEN", "AGENTRUN_ATTACH_URL", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_DAEMON_URL", "AGENTRUN_INIT_ARGS"], ...(kind === "desktop" ? ["DISPLAY"] : [])].sort(), String(kind));
		assert.equal(env.DISPLAY, kind === "desktop" ? ":0" : undefined);
		assert.equal(instance, "standard-3", "a desktop's size is the sandbox's: 2 vCPUs, 8 GiB");
	}
});

test("Cloudflare's desktop configuration, as serve builds it, makes a desktop over dial: the container boots from the env the relay was given, dials, and its X server and xfwm4 start over that socket", async () => {
	const dial = dialServer();
	const daemonPath = fileURLToPath(import.meta.url);
	const rows = new Map();
	let booted;
	// A relay that keeps what it makes: the container boots from the env it was posted (bootDial).
	const relay = fakeRelay((method, url, body) => {
		const name = url.pathname.split("/")[3];
		if (url.pathname === "/v1/health") return { json: { version: CLOUDFLARE_RELAY_VERSION, image: BOX } };
		if (method === "POST" && url.pathname === "/v1/computers") {
			rows.set(body.name, { ...row("running"), name: body.name, labels: body.labels, image: body.image });
			booted = bootDial(body.env, dial, { daemon: readFileSync(daemonPath) });
			return { status: 201, json: rows.get(body.name) };
		}
		if (method === "GET" && url.pathname === "/v1/computers") return { json: { computers: [...rows.values()].filter(({ labels }) => [...url.searchParams].every(([key, value]) => labels[key] === value)) } };
		if (method === "GET" && rows.has(name)) return { json: rows.get(name) };
		if (method === "DELETE" && rows.has(name)) {
			rows.delete(name);
			return { status: 204 };
		}
		return undefined;
	});
	const { options } = registry.descriptorOf("cloudflare").capabilities.find(({ kind }) => kind === "desktop");
	const made = provider(relay, { ...options, dial, daemonPath });
	assert.equal(made.capabilities().kind, "desktop");
	await desktopOverDial(made, dial, () => booted, { image: BOX, lifetimeMs: 600_000, network: "none" });
	assert.equal(relay.calls.find(({ method }) => method === "POST").body.instance, "standard-3");
	assert.equal(rows.size, 0, "release deleted the container");
});

test("the constructor refuses a relay URL that is not https and a missing token, never echoing the token", () => {
	assert.throws(() => new CloudflareProvider({ relayUrl: RELAY }), /options.relayToken, the relay's RELAY_TOKEN, is required/);
	for (const relayUrl of ["http://relay.example.com", "http://127.0.0.1:8787", "http://localhost:8787"]) {
		assert.throws(() => new CloudflareProvider({ relayUrl, relayToken: TOKEN }), (error) => /^the Cloudflare relay URL must be https, so the key never crosses in the clear/.test(error.message) && !error.message.includes(TOKEN), relayUrl);
	}
	assert.throws(() => new CloudflareProvider({ relayToken: TOKEN }), /options\.relayUrl, the relay Worker's https address as wrangler deploy printed it, is required/);
	assert.ok(create({ relayUrl: RELAY, relayToken: TOKEN }) instanceof CloudflareProvider);
});

test("cloudflare is in the registry; its conformance module reads COMPUTER_CLOUDFLARE_* alone and refuses a dialKit off the public server", async () => {
	assert.ok(registry.providerIds.includes("cloudflare"));
	assert.equal((await registry.providerModule("cloudflare")).create, create);
	assert.deepEqual(cloudflareModule.ENV, { url: "COMPUTER_CLOUDFLARE_RELAY_URL", token: "COMPUTER_CLOUDFLARE_RELAY_TOKEN", kind: "COMPUTER_CLOUDFLARE_KIND" });
	assert.throws(() => cloudflareModule.settingsFromEnv({ COMPUTER_CLOUDFLARE_RELAY_URL: RELAY }), /needs COMPUTER_CLOUDFLARE_RELAY_URL and COMPUTER_CLOUDFLARE_RELAY_TOKEN/);
	const env = { COMPUTER_CLOUDFLARE_RELAY_URL: RELAY, COMPUTER_CLOUDFLARE_RELAY_TOKEN: TOKEN };
	assert.equal(cloudflareModule.createProvider({ env }).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal(cloudflareModule.sweepScope({ env }), `the Cloudflare relay at ${RELAY}`);
	assert.equal(await cloudflareModule.conformanceImage({ env, fetch: fakeRelay(health()).fetch }), BOX);
	assert.throws(() => cloudflareModule.dialKit({ env }), /^Error: Cloudflare's machines dial the server that minted their tokens, and this run has no public server: run its Core with packages\/serve\/scripts\/dial-conformance\.mjs --provider cloudflare/);
});
