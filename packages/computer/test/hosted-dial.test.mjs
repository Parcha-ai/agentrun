// The dial host mode (src/host.ts facts.connect "dial", HostedOptions.dial) against the fake dial host
// (fake-dial-host.mjs): create mints the machine's token and boots it with env, waits for its socket in the hub, and
// reads it back over that socket; a server with no public address makes nothing; a machine that never dials is deleted;
// delete revokes the token; Core's provider cases, provider.dial-token among them, pass over it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ATTACH_CLOSE, AttachHub, helloMismatch, hostedDaemonPath, MACHINE_TOKEN_SOURCE, MemoryMachineTokens, mintedComputer, mountsOf } from "../dist/index.js";
import { HostedProvider } from "../dist/hosted/provider.js";
import { fakeDialHost, PUBLIC_URL } from "./fake-dial-host.mjs";
import { fakeHost } from "./fake-host.mjs";

const dir = mkdtempSync(join(tmpdir(), "computer-dial-"));
const DAEMON_PATH = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, linux/amd64\n");
writeFileSync(DAEMON_PATH, DAEMON_BYTES);
test.after(() => rmSync(dir, { recursive: true, force: true }));

const TIMEOUTS = { requestMs: 2_000, createMs: 1_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };
const SPEC = { image: "img", lifetimeMs: 600_000, network: "none" };
let requests = 0;
const create = (provider, spec = SPEC) => provider.create(spec, { requestId: `dial-${++requests}` });
const made = (result) => {
	assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
	return result.value;
};
const setup = (options = {}, providerOptions = {}) => {
	const dial = fakeDialHost({ daemon: DAEMON_BYTES, ...options });
	return { ...dial, provider: dial.provider({ daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...providerOptions }) };
};
const NO_ADDRESS = /^Fakehost machines dial this server, and it has no public https address: set AGENTRUN_PUBLIC_URL to one the internet reaches \(a tunnel such as cloudflared or tailscale funnel works\), or use a provider whose host has exec$/;

test("a dial create boots the machine with its env, runs nothing in it, and reads it back over the socket it dialed", async () => {
	const { fake, provider, hub, tokens } = setup();
	const ref = made(await create(provider));
	const [, request] = fake.calls.find(([what]) => what === "create");
	const env = request.boot.env;
	assert.deepEqual(Object.keys(env).sort(), ["AGENTRUN_ATTACH_TOKEN", "AGENTRUN_ATTACH_URL", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_DAEMON_URL", "AGENTRUN_INIT_ARGS"]);
	assert.equal(env.AGENTRUN_ATTACH_URL, "ws://127.0.0.1:8080/v2/computers/attach");
	assert.equal(env.AGENTRUN_DAEMON_URL, "http://127.0.0.1:8080/v2/computers/daemon?arch=amd64");
	assert.match(env.AGENTRUN_ATTACH_TOKEN, new RegExp(`^${MACHINE_TOKEN_SOURCE}$`));
	assert.match(env.AGENTRUN_DAEMON_SHA256, /^[0-9a-f]{64}$/);
	assert.equal(env.AGENTRUN_INIT_ARGS, `--deadline ${request.labels["agentrun.computer.deadline"]} --user 2510:2510 --own-network --max-deadline ${request.labels["agentrun.computer.max-deadline"]}`);
	assert.equal(request.command, undefined, "no entrypoint: agentrun-dial starts init");
	assert.equal(request.egress, true, "its root reaches this server, with its tools' network none");
	// The token stops at the machine's backstop.
	assert.equal(tokens.check(env.AGENTRUN_ATTACH_TOKEN)?.machine, ref.name);
	assert.equal(tokens.check(env.AGENTRUN_ATTACH_TOKEN)?.mint.expiresAt.toISOString(), request.backstopAt);
	assert.deepEqual(fake.events.filter(({ what }) => what.startsWith("run ")), [], "nothing was run in the machine");
	assert.equal(hub.online(ref.name), true, "its socket is the hub's");

	const connection = made(await provider.connect(ref));
	assert.deepEqual(made(await connection.client.call("ping", {})), {});
	await connection.close();
	made(await provider.release(ref, "delete"));
	assert.equal(tokens.check(env.AGENTRUN_ATTACH_TOKEN), undefined, "delete revoked the token");
	assert.equal(hub.online(ref.name), false, "and closed its socket");
	assert.deepEqual(fake.live(), []);
});

test("a dial create's mint names the run its labels name (agentrun.run), and none for a computer of no run", async () => {
	const { fake, provider, tokens } = setup();
	const ofRun = made(await create(provider, { ...SPEC, labels: { "agentrun.run": "run-7", "agentrun.epoch": "1" } }));
	const runToken = fake.calls.filter(([what]) => what === "create").at(-1)[1].boot.env.AGENTRUN_ATTACH_TOKEN;
	assert.equal(tokens.check(runToken)?.mint.run, "run-7", "the token's mint names its run");
	const ofNone = made(await create(provider));
	const noneToken = fake.calls.filter(([what]) => what === "create").at(-1)[1].boot.env.AGENTRUN_ATTACH_TOKEN;
	assert.equal(tokens.check(noneToken)?.mint.run, undefined, "a computer of no run names none");
	for (const ref of [ofRun, ofNone]) made(await provider.release(ref, "delete"));
});

test("a release of a machine gone already revokes its token and closes its socket", async () => {
	const { fake, provider, hub, tokens } = setup();
	const ref = made(await create(provider));
	const token = fake.calls.find(([what]) => what === "create")[1].boot.env.AGENTRUN_ATTACH_TOKEN;
	fake.vanish(ref.id);
	made(await provider.release(ref, "delete"));
	assert.equal(tokens.check(token), undefined);
	assert.equal(hub.online(ref.name), false);
});

test("two provider instances of one server creating one request at once make one machine, which stays attached", async () => {
	const { fake, hub, provider: instance } = fakeDialHost({ daemon: DAEMON_BYTES });
	const [a, b] = [instance({ daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }), instance({ daemonPath: DAEMON_PATH, timeouts: TIMEOUTS })];
	const [first, second] = (await Promise.all([a.create(SPEC, { requestId: "dial-twice" }), b.create(SPEC, { requestId: "dial-twice" })])).map(made);
	assert.equal(second.id, first.id);
	assert.equal(fake.creates(), 1);
	assert.equal(hub.online(first.name), true);
	const connection = made(await b.connect(second));
	assert.deepEqual(made(await connection.client.call("ping", {})), {});
	await connection.close();
	made(await a.release(first, "delete"));
});

test("a create that aborts while another of its request is in flight stops waiting, and the next still waits its turn", async () => {
	const { fake, provider: instance } = fakeDialHost({ daemon: DAEMON_BYTES, create: "hold" });
	const [a, b, c] = [1, 2, 3].map(() => instance({ daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, createMs: 5_000 } }));
	const first = a.create(SPEC, { requestId: "dial-held" });
	const abort = new AbortController();
	const second = b.create(SPEC, { requestId: "dial-held", signal: abort.signal });
	const third = c.create(SPEC, { requestId: "dial-held" });
	abort.abort();
	const stopped = await second;
	assert.equal(stopped.ok, false);
	assert.equal(stopped.error.code, "aborted");
	assert.match(stopped.error.message, /another create of this request was in flight/);
	while (fake.creates() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
	await fake.release();
	const [one, three] = [await first, await third].map(made);
	assert.equal(three.id, one.id, "the third waited for the first, and found its machine");
	assert.equal(fake.creates(), 1);
	made(await a.release(one, "delete"));
});

test("the conformance CLI passes a module's dialKit to the run: provider.dial-token passes through it", async () => {
	const { main } = await import("../dist/conformance/cli.js");
	let text = "";
	const stdout = { write: (chunk, done) => ((text += chunk), done?.(), true) };
	await main(["--provider", "./fixtures/dial-provider.mjs", "--only", "provider.dial-token", "--json"], { stdout, cwd: new URL(".", import.meta.url).pathname });
	const result = JSON.parse(text).results.find(({ id }) => id === "provider.dial-token");
	assert.equal(result?.status, "pass", JSON.stringify(result));
});

test("two mints of one machine at once leave one token, and its revoke refuses both", async () => {
	const tokens = new MemoryMachineTokens();
	const mint = { kind: "linux", os: "linux", arch: "amd64", expiresAt: new Date(Date.now() + 60_000) };
	const both = await Promise.all([tokens.mint("computer-5f3a9c1e7b2d", mint), tokens.mint("computer-5f3a9c1e7b2d", mint)]);
	await tokens.revoke("computer-5f3a9c1e7b2d");
	assert.deepEqual(both.map((token) => tokens.check(token)), [undefined, undefined]);
});

test("a server with no public https address refuses a dial create in words before the vendor is called", async () => {
	for (const url of [undefined, "", "http://agentrun.example.com", "not a url"]) {
		const { fake, provider } = setup({}, { dial: { url, tokens: new MemoryMachineTokens(), hub: new AttachHub() } });
		const refused = await create(provider);
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, "refused");
		assert.match(refused.error.message, NO_ADDRESS, String(url));
		assert.equal(fake.creates(), 0, `${url}: no create reached the vendor`);
	}
});

test("the machine's addresses are built from the parsed public URL: any case of scheme, a path kept, a trailing slash dropped", async () => {
	for (const [url, attach, daemon] of [
		["HTTP://127.0.0.1:8080/", "ws://127.0.0.1:8080/v2/computers/attach", "http://127.0.0.1:8080/v2/computers/daemon?arch=amd64"],
		["http://127.0.0.1:8080/agentrun//", "ws://127.0.0.1:8080/agentrun/v2/computers/attach", "http://127.0.0.1:8080/agentrun/v2/computers/daemon?arch=amd64"],
	]) {
		const { fake, provider, tokens, hub } = setup({}, {});
		const dialing = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, dial: { url, tokens, hub } });
		const ref = made(await create(dialing));
		const { env } = fake.calls.find(([what]) => what === "create")[1].boot;
		assert.deepEqual([env.AGENTRUN_ATTACH_URL, env.AGENTRUN_DAEMON_URL], [attach, daemon], url);
		made(await provider.release(ref, "delete"));
	}
});

test("delete revokes the machine's token before it closes the socket, and closes it when the revoke fails", async () => {
	const { fake, tokens, hub } = setup();
	const order = [];
	let fails = false;
	const dial = {
		url: PUBLIC_URL,
		tokens: { mint: (machine, mint) => tokens.mint(machine, mint), revoke: async (machine) => (order.push("token"), fails ? Promise.reject(new Error("the store is down")) : tokens.revoke(machine)), refused: (machine) => tokens.refused(machine) },
		hub: { online: (id) => hub.online(id), connection: (id) => hub.connection(id), revoke: (id, why) => (order.push("socket"), hub.revoke(id, why)) },
	};
	const notes = [];
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, dial, onNote: (note) => notes.push(note.note) });
	for (const failing of [false, true]) {
		fails = failing;
		order.length = 0;
		const ref = made(await create(provider));
		made(await provider.release(ref, "delete"));
		assert.deepEqual(order, ["token", "socket"], `revoke fails: ${failing}`);
		assert.equal(hub.online(ref.name), false);
	}
	assert.match(notes.join("\n"), /its machine token could not be revoked \(the store is down\)/);
});

test("a token store that never answers a revoke holds a delete back no longer than requestMs: the socket closes and the machine is deleted", async () => {
	const { fake, tokens, hub } = setup();
	const dial = { url: PUBLIC_URL, tokens: { mint: (machine, mint) => tokens.mint(machine, mint), revoke: () => new Promise(() => {}), refused: (machine) => tokens.refused(machine) }, hub };
	const notes = [];
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, requestMs: 300 }, dial, onNote: (note) => notes.push(note.note) });
	const ref = made(await create(provider));
	made(await provider.release(ref, "delete"));
	assert.equal(hub.online(ref.name), false);
	assert.deepEqual(fake.live(), []);
	assert.deepEqual(notes, ["its machine token could not be revoked (the token store did not answer within 0.3 s): it is refused past the machine's backstop either way"]);
});

// A runner apart from the server (serve's dial-relay.ts): the server keeps its refusal to relay a machine's dial on the
// token's row, and the runner's create reads it (MachineTokens refused) instead of waiting out createMs.
test("a machine whose dial the server refused ends create at once in the server's words, which name no token, and is deleted", async () => {
	const { fake, tokens, hub } = setup({ dials: false });
	const said = new Map();
	const dial = {
		url: PUBLIC_URL,
		tokens: {
			async mint(machine, mint) {
				const token = await tokens.mint(machine, mint);
				setTimeout(() => said.set(machine, `a dial for run run-7 (machine ${machine}): runner runner-b, which made it, is not running now`), 50);
				return token;
			},
			revoke: (machine) => tokens.revoke(machine),
			refused: async (machine) => said.get(machine),
		},
		hub,
	};
	const createMs = 20_000;
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, createMs }, dial });
	const started = Date.now();
	const refused = await create(provider, { ...SPEC, labels: { "agentrun.run": "run-7" } });
	const took = Date.now() - started;
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "refused", refused.error.message);
	assert.match(refused.error.message, /the server refused a dial for run run-7 \(machine computer-[0-9a-f]{12}\): runner runner-b, which made it, is not running now$/);
	assert.doesNotMatch(refused.error.message, /art_/);
	assert.ok(took < createMs / 4, `create ended at the refusal, not at createMs: ${took} ms`);
	assert.deepEqual(fake.live(), [], "the machine was deleted");
});

// The refusal read never holds the hub check back: a token store that stalls on refused() costs no machine that attached
// meanwhile, no abort waits on it, and it never holds create past createMs.
const stalling = (tokens, refused = () => new Promise(() => {})) => ({ mint: (machine, mint) => tokens.mint(machine, mint), revoke: (machine) => tokens.revoke(machine), refused });

test("a machine that attaches while the token store stalls on its refusal read is returned as it attaches, and kept", { timeout: 15_000 }, async () => {
	const { fake, tokens, hub } = setup();
	let reads = 0;
	let attached = false;
	const refused = () => {
		if (reads++ === 0) setTimeout(() => (attached = true), 200);
		return new Promise(() => {});
	};
	// The hub as the provider sees it: the machine's socket is there 200 ms into the first read, which never answers.
	const seen = { connection: (name) => (attached ? hub.connection(name) : undefined), revoke: (name, why) => hub.revoke(name, why) };
	const createMs = 3_000;
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, requestMs: 6_000, createMs }, dial: { url: PUBLIC_URL, tokens: stalling(tokens, refused), hub: seen } });
	const started = Date.now();
	const ref = made(await create(provider));
	const took = Date.now() - started;
	assert.ok(took < createMs / 2, `create answered at the attach, not at the read's end: ${took} ms`);
	assert.equal(reads, 1, "one refusal read in flight at a time");
	assert.equal(fake.live().length, 1, "the machine was kept");
	made(await provider.release(ref, "delete"));
});

test("an abort while the token store stalls on a refusal read ends create at once as aborted, and the machine is deleted", { timeout: 15_000 }, async () => {
	const { fake, tokens, hub } = setup({ dials: false });
	const abort = new AbortController();
	const refused = () => {
		setTimeout(() => abort.abort(), 100);
		return new Promise(() => {});
	};
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, requestMs: 3_000, createMs: 4_000 }, dial: { url: PUBLIC_URL, tokens: stalling(tokens, refused), hub } });
	const started = Date.now();
	const aborted = await provider.create(SPEC, { requestId: `dial-${++requests}`, signal: abort.signal });
	const took = Date.now() - started;
	assert.equal(aborted.ok, false);
	assert.equal(aborted.error.code, "aborted", aborted.error.message);
	assert.ok(took < 1_000, `create ended at the abort, not at the read's requestMs: ${took} ms`);
	assert.deepEqual(fake.live(), [], "the machine was deleted");
});

test("a refusal read the token store never answers holds create no later than createMs: it fails timeout then, and the machine is deleted", { timeout: 15_000 }, async () => {
	const { fake, tokens, hub } = setup({ dials: false });
	const createMs = 100;
	// pollMs 50: a poll of 500 ms, longer than createMs, so a pause past the time left shows too.
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, requestMs: 5_000, createMs, pollMs: 50 }, dial: { url: PUBLIC_URL, tokens: stalling(tokens), hub } });
	const started = Date.now();
	const failed = await create(provider);
	const took = Date.now() - started;
	assert.equal(failed.ok, false);
	assert.equal(failed.error.code, "timeout", failed.error.message);
	assert.match(failed.error.message, /did not dial ws:\/\/127\.0\.0\.1:8080\/v2\/computers\/attach within 0\.1 s/);
	assert.ok(took < 450, `create ended at createMs, not at the read's requestMs or a poll past createMs: ${took} ms`);
	assert.deepEqual(fake.live(), [], "the machine was deleted");
});

// A provider is given no dial in a runner apart from the server (serve's runner subcommand, and the container image's
// default server-and-runner): the refusal names the one-line fix in the words a paired computer's refusal gives
// (serve's workspace/attached-computers.ts ONE_PROCESS_FIX).
test("a dial host's provider given no dial refuses create in its own words, of the process and its fix, before the vendor is called", async () => {
	const { fake } = fakeDialHost({ daemon: DAEMON_BYTES });
	const refused = await create(new HostedProvider(fake.host, { daemonPath: DAEMON_PATH }));
	assert.equal(refused.error?.code, "refused");
	assert.equal(
		refused.error.message,
		"Fakehost machines dial in to this server, and this runner runs in a process of its own, with no attach hub to take their socket: start the image with the server options alone, without server-and-runner (outside the image: agentrun-serve without --no-runner)",
	);
	assert.equal(fake.creates(), 0);
});

test("a host whose machines don't dial ignores a dial option: it creates and connects through exec, with no boot env", async () => {
	const fake = fakeHost();
	const provider = new HostedProvider(fake.host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, dial: { url: PUBLIC_URL, tokens: new MemoryMachineTokens(), hub: new AttachHub() } });
	const ref = made(await create(provider));
	const [, request] = fake.calls.find(([what]) => what === "create");
	assert.equal(request.boot, undefined);
	const connection = made(await provider.connect(ref));
	assert.deepEqual(made(await connection.client.call("ping", {})), {});
	await connection.close();
	made(await provider.release(ref, "delete"));
	assert.deepEqual(fake.live(), []);
});

test("hostedDaemonPath(arch) is the build in dist a hosted machine of that arch runs, the file serve's daemon route serves", () => {
	for (const arch of ["amd64", "arm64"]) assert.equal(hostedDaemonPath(arch), fileURLToPath(new URL(`../dist/computerd-linux-${arch}`, import.meta.url)));
});

test("HostedProvider's default daemonPath is hostedDaemonPath(facts.arch): the sha256 a dial machine checks is that file's", async () => {
	for (const arch of ["amd64", "arm64"]) {
		const path = hostedDaemonPath(arch);
		const built = existsSync(path);
		const { fake, provider } = fakeDialHost({ daemon: built ? readFileSync(path) : DAEMON_BYTES, facts: { arch } });
		const result = await create(provider({ timeouts: TIMEOUTS }));
		if (built) {
			made(result);
			const { env } = fake.calls.find(([what]) => what === "create")[1].boot;
			assert.equal(env.AGENTRUN_DAEMON_SHA256, createHash("sha256").update(readFileSync(path)).digest("hex"), arch);
		} else {
			// No build here (npm run build:daemon makes them): the create names the file it read.
			assert.equal(result.error?.code, "not_found");
			assert.equal(result.error.message.includes(`no daemon binary at ${path}:`), true, result.error.message);
		}
	}
});

test("a machine that never dials is deleted, its token revoked, and create fails naming the address it was given", async () => {
	const { fake, provider, tokens } = setup({ dials: false });
	const failed = await create(provider);
	assert.equal(failed.ok, false);
	assert.equal(failed.error.code, "timeout");
	assert.match(failed.error.message, /did not dial ws:\/\/127\.0\.0\.1:8080\/v2\/computers\/attach within 1 s/);
	const [, request] = fake.calls.find(([what]) => what === "create");
	assert.equal(tokens.check(request.boot.env.AGENTRUN_ATTACH_TOKEN), undefined);
	assert.deepEqual(fake.live(), [], "the machine was deleted");
});

test("a machine that never dials: the timeout leads with the host's dialLog, its last 10 lines within 800 characters, or that agentrun-dial never started; a dialLog that fails, or none, keeps the message", { timeout: 30_000 }, async () => {
	const DIALED = "did not dial ws://127.0.0.1:8080/v2/computers/attach within 0.05 s: the machine must reach that address";
	const SAID = "agentrun-dial said: ";
	/** What agentrun-dial said, as the words lead with it: from SAID to the name of the machine that did not dial. */
	const saidOf = (message) => message.slice(message.indexOf(SAID) + SAID.length, message.search(/; computer-[0-9a-f]{12} did not dial/));
	// A fake that never dials: create gives up at createMs, so these wait 50 ms each.
	const QUICK = { timeouts: { ...TIMEOUTS, createMs: 50 } };
	const lines = Array.from({ length: 15 }, (_, at) => `line ${at + 1}`);
	const said = setup({ dials: false }, QUICK);
	const asked = [];
	said.fake.host.dialLog = async (id) => {
		asked.push(id);
		return `${lines.join("\n")}\n\n`;
	};
	const failed = await create(said.provider);
	assert.equal(failed.error?.code, "timeout");
	assert.ok(failed.error.message.includes(DIALED), failed.error.message);
	assert.equal(saidOf(failed.error.message), lines.slice(5).join(" | "), failed.error.message);
	assert.equal(asked.length, 1, "asked once, at the timeout");
	assert.equal(typeof asked[0], "string");
	assert.deepEqual(said.fake.live(), [], "the machine was deleted");

	const long = setup({ dials: false }, QUICK);
	long.fake.host.dialLog = async () => `start\n${"x".repeat(2_000)}y\n`;
	const cut = await create(long.provider);
	const tail = saidOf(cut.error.message);
	assert.equal(tail.length, 800, "the last 800 characters");
	assert.ok(tail.endsWith("xy"));

	// A machine token agentrun-dial wrote, every time, is replaced by the adapter: no host has to remember it.
	const TOKEN = `art_fake-test-key-not-a-secret-${"0".repeat(16)}`;
	assert.match(TOKEN, new RegExp(`^${MACHINE_TOKEN_SOURCE}$`));
	const leaky = setup({ dials: false }, QUICK);
	leaky.fake.host.dialLog = async () => `sent ${TOKEN}\n${TOKEN} was refused\n`;
	const redacted = await create(leaky.provider);
	assert.equal(saidOf(redacted.error.message), "sent <token> | <token> was refused", redacted.error.message);
	// A longer word whose tail reads like a token is no token: it is left whole.
	const WORD = `restart_${"a".repeat(43)}`;
	const wordy = setup({ dials: false }, QUICK);
	wordy.fake.host.dialLog = async () => `${WORD} AGENTRUN_ATTACH_TOKEN=${TOKEN}\n`;
	const kept = await create(wordy.provider);
	assert.equal(saidOf(kept.error.message), `${WORD} AGENTRUN_ATTACH_TOKEN=<token>`, kept.error.message);

	const never = setup({ dials: false }, QUICK);
	never.fake.host.dialLog = async () => undefined;
	const silent = await create(never.provider);
	assert.equal(silent.error?.code, "timeout");
	assert.match(silent.error.message, /: agentrun-dial never started; computer-[0-9a-f]{12} did not dial/, silent.error.message);

	// A cancel while the log read stalls ends the wait at once: the read never holds create's cleanup back. The read's
	// bound is ten minutes, so a cancel that failed to cut it would hang into the test's own 30 s bound and fail there.
	const stalled = setup({ dials: false }, { timeouts: { ...QUICK.timeouts, requestMs: 600_000 } });
	const cancel = new AbortController();
	stalled.fake.host.dialLog = () => {
		queueMicrotask(() => cancel.abort());
		return new Promise(() => {});
	};
	const cancelled = await stalled.provider.create(SPEC, { requestId: `dial-${++requests}`, signal: cancel.signal });
	assert.equal(cancelled.ok, false);
	assert.doesNotMatch(cancelled.error.message, /agentrun-dial said|never started/);

	for (const dialLog of [async () => Promise.reject(new Error("the toolbox is down")), undefined]) {
		const plain = setup({ dials: false }, QUICK);
		if (dialLog) plain.fake.host.dialLog = dialLog;
		const kept = await create(plain.provider);
		assert.equal(kept.error?.code, "timeout", "a log read that fails never changes the code");
		assert.ok(kept.error.message.includes(DIALED), kept.error.message);
		assert.doesNotMatch(kept.error.message, /agentrun-dial said|never started|the toolbox is down/);
		assert.deepEqual(plain.fake.live(), []);
	}
});

/** agentrun-dial's words for a fetch the relay dropped in TLS, as it writes them. */
const CURL_35 = "curl: (35) TLS connect error: error:0A000126:SSL routines::unexpected eof while reading";
const FETCH_FAILED = `${CURL_35}\nagentrun-dial: fetching the daemon from http://127.0.0.1:8080/v2/computers/daemon?arch=amd64 failed: curl exit 35, after 4 tries\n`;

test("a dial host whose agentrun-dial exits before attaching fails create within a poll, not at createMs, carrying its exit and log; a sha256 refusal (4) and a server refusal (7) are never started again", { timeout: 30_000 }, async () => {
	for (const [exit, log] of [
		[4, "agentrun-dial: the daemon from http://127.0.0.1:8080/v2/computers/daemon?arch=amd64 reads sha256 ab, not cd, so nothing runs\n"],
		[7, "agentrun-dial: fetching the daemon from http://127.0.0.1:8080/v2/computers/daemon?arch=amd64 failed: the server answered HTTP 401\n"],
	]) {
		const { fake, provider, tokens } = setup({ starts: [{ exit, log }] }, { timeouts: { ...TIMEOUTS, createMs: 10_000, pollMs: 10 } });
		const began = Date.now();
		const failed = await create(provider);
		assert.equal(failed.ok, false);
		assert.ok(Date.now() - began < 1_000, `failed in ${Date.now() - began} ms, not at createMs`);
		assert.equal(failed.error.code, "refused");
		assert.ok(failed.error.message.includes(`agentrun-dial said: ${log.trim()}; `), failed.error.message);
		assert.match(failed.error.message, new RegExp(`computer-[0-9a-f]{12} did not dial ws://127\\.0\\.0\\.1:8080/v2/computers/attach: agentrun-dial exited ${exit}: the machine must reach that address`));
		assert.deepEqual(fake.redials, [], `exit ${exit} is not started again`);
		const [, request] = fake.calls.find(([what]) => what === "create");
		assert.equal(tokens.check(request.boot.env.AGENTRUN_ATTACH_TOKEN), undefined, "its token is revoked");
		assert.deepEqual(fake.live(), [], "the machine was deleted");
	}
});

test("an agentrun-dial that exits 3 (its fetch failed) or 5 (init never listened) is started once more in the same machine, and the machine that dials then is returned, with a note naming the first exit", async () => {
	for (const exit of [3, 5]) {
		const { fake, provider, hub } = setup({ starts: [{ exit, log: FETCH_FAILED }, "dials"] }, { timeouts: { ...TIMEOUTS, createMs: 10_000 } });
		const ref = made(await create(provider));
		assert.equal(fake.creates(), 1, "one machine");
		assert.deepEqual(fake.redials, [ref.id], "agentrun-dial started once more, in it");
		assert.equal(hub.online(ref.name), true);
		const notes = ref.notes ?? [];
		assert.equal(notes.filter((note) => note.includes("started once more")).length, 1, JSON.stringify(notes));
		assert.ok(notes.some((note) => note.startsWith(`agentrun-dial's first start in ${ref.name} exited ${exit}`) && note.includes(CURL_35)), JSON.stringify(notes));
		made(await provider.release(ref, "delete"));
		assert.deepEqual(fake.live(), []);
	}
});

test("an agentrun-dial that exits 3 again after its second start fails create, naming both exits; it is started once more at most", async () => {
	const { fake, provider } = setup({ starts: [{ exit: 3, log: FETCH_FAILED }, { exit: 3, log: FETCH_FAILED }, "dials"] }, { timeouts: { ...TIMEOUTS, createMs: 10_000 } });
	const failed = await create(provider);
	assert.equal(failed.ok, false);
	assert.equal(failed.error.code, "refused");
	assert.equal(fake.redials.length, 1);
	assert.match(failed.error.message, /agentrun-dial exited 3, and its first start exited 3 before it was started once more/);
	assert.deepEqual(fake.live(), []);
});

test("a dial host's agentrun-dial that is alive and writing past createMs is waited for, up to twice createMs; a silent one is not", { timeout: 30_000 }, async () => {
	const QUICK = { timeouts: { ...TIMEOUTS, createMs: 400, pollMs: 5 } };
	// One line every 20 ms: a fetch it is still trying, then init starting.
	const writing = (ms) => Array.from({ length: Math.floor(ms / 20) + 1 }, (_, at) => `agentrun-dial: try ${at + 1}`).join("\n");
	const late = setup({ starts: [{ log: writing, dialsAfterMs: 600 }] }, QUICK);
	const began = Date.now();
	const ref = made(await create(late.provider));
	assert.ok(Date.now() - began >= 600, "it dialed past createMs, and was waited for");
	made(await late.provider.release(ref, "delete"));

	const never = setup({ starts: [{ log: writing }] }, QUICK);
	const start = Date.now();
	// Aborted at 3 s: a wait with no cap ends "aborted", never "timeout".
	const capped = await never.provider.create(SPEC, { requestId: `dial-${++requests}`, signal: AbortSignal.timeout(3_000) });
	const took = Date.now() - start;
	assert.equal(capped.error?.code, "timeout");
	assert.ok(took >= 800 && took < 3_000, `ended at twice createMs: ${took} ms`);
	assert.match(capped.error.message, /did not dial ws:\/\/127\.0\.0\.1:8080\/v2\/computers\/attach within 0\.8 s/);
	assert.deepEqual(never.fake.live(), []);

	const silent = setup({ starts: [{ log: "agentrun-dial: waiting\n" }] }, QUICK);
	const quiet = Date.now();
	const ended = await create(silent.provider);
	assert.equal(ended.error?.code, "timeout");
	assert.ok(Date.now() - quiet < 800, `a silent one ends at createMs: ${Date.now() - quiet} ms`);
	assert.match(ended.error.message, /within 0\.4 s/);
});

test("a slow read of the dial log holds no poll back: a machine that dials while it runs is opened at once, never timed out", { timeout: 30_000 }, async () => {
	// The step's first read starts at 600 ms (a step before createMs) and answers at 1,200 ms; the machine dials at 700.
	const slow = setup({ starts: [{ log: "agentrun-dial: try 1", logMs: 600, dialsAfterMs: 700 }] }, { timeouts: { ...TIMEOUTS, createMs: 800, pollMs: 5 } });
	const began = Date.now();
	const ref = made(await create(slow.provider));
	assert.ok(Date.now() - began < 1_100, `opened as it dialed, not after the read: ${Date.now() - began} ms`);
	assert.equal(slow.fake.live().length, 1, "the machine that dialed is kept");
	made(await slow.provider.release(ref, "delete"));
});

test("a machine that dials while the dial log is read at the deadline is opened, not timed out and deleted", { timeout: 30_000 }, async () => {
	// The reads run from 300 to 600 ms and from 600 to 900, past createMs (400); the machine dials at 450.
	const late = setup({ starts: [{ log: "agentrun-dial: try 1", logMs: 300, dialsAfterMs: 450 }] }, { timeouts: { ...TIMEOUTS, createMs: 400, pollMs: 5 } });
	const ref = made(await create(late.provider));
	assert.equal(late.fake.live().length, 1, "the machine that dialed is kept");
	made(await late.provider.release(ref, "delete"));
});

test("the dial failure's words begin with what agentrun-dial said: its curl line is in the first 200 characters, for an exit and for a timeout", async () => {
	const exited = setup({ starts: [{ exit: 4, log: FETCH_FAILED }] }, { attachEgress: "192.0.2.40:18443" });
	const early = await create(exited.provider);
	assert.ok(early.error.message.slice(0, 200).includes(CURL_35), early.error.message);
	const silent = setup({ dials: false }, { attachEgress: "192.0.2.40:18443", timeouts: { ...TIMEOUTS, createMs: 50 } });
	silent.fake.host.dialLog = async () => FETCH_FAILED;
	const late = await create(silent.provider);
	assert.equal(late.error.code, "timeout");
	assert.ok(late.error.message.slice(0, 200).includes(CURL_35), late.error.message);
});

test("attachEgress: the machine is booted with AGENTRUN_ATTACH_EGRESS beside the five names, one that never dials fails naming the relay too, and a malformed one is refused at construction", async () => {
	const { fake, provider } = setup({}, { attachEgress: "192.0.2.40:18443" });
	const ref = made(await create(provider));
	const { env } = fake.calls.find(([what]) => what === "create")[1].boot;
	assert.deepEqual(Object.keys(env).sort(), ["AGENTRUN_ATTACH_EGRESS", "AGENTRUN_ATTACH_TOKEN", "AGENTRUN_ATTACH_URL", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_DAEMON_URL", "AGENTRUN_INIT_ARGS"]);
	assert.equal(env.AGENTRUN_ATTACH_EGRESS, "192.0.2.40:18443");
	assert.equal(env.AGENTRUN_ATTACH_URL, "ws://127.0.0.1:8080/v2/computers/attach", "the address dialed by name is the public one still");
	made(await provider.release(ref, "delete"));

	const silent = setup({ dials: false }, { attachEgress: "192.0.2.40:18443" });
	const failed = await create(silent.provider);
	assert.equal(failed.error?.code, "timeout");
	assert.match(failed.error.message, /did not dial ws:\/\/127\.0\.0\.1:8080\/v2\/computers\/attach through 192\.0\.2\.40:18443 within 1 s/);
	assert.deepEqual(silent.fake.live(), []);

	const empty = setup({}, { attachEgress: "" });
	made(await create(empty.provider));
	assert.equal("AGENTRUN_ATTACH_EGRESS" in empty.fake.calls.find(([what]) => what === "create")[1].boot.env, false, "an empty egress is none");
	assert.throws(() => setup({}, { attachEgress: "relay.example:18443" }), /the attach egress is <IPv4 relay>:<port>, such as 192\.0\.2\.40:18443, a port from 1 to 65535; not "relay\.example:18443"/);
});

test("a machine whose daemon's sha256 is not the server's never dials, and create fails", async () => {
	const { fake, provider } = setup({ daemon: Buffer.from("another build") });
	const failed = await create(provider);
	assert.equal(failed.error?.code, "timeout");
	assert.deepEqual(fake.dialed, []);
	assert.deepEqual(fake.live(), []);
});

test("a dial host takes no Archil mount, in words, and declares a synced folder alone", async () => {
	const { fake, provider } = setup();
	assert.deepEqual(provider.capabilities().mount, ["sync"]);
	const refused = await create(provider, { ...SPEC, mount: { kind: "archil", disk: "dsk-0123456789abcdef", region: "aws-us-east-1", folder: "agents/a/runs/r/work" } });
	assert.equal(refused.ok, false);
	assert.ok(refused.error.message.includes(`mount: ${mountsOf(provider.host.descriptor, () => false, true).unmounted.archil}`), refused.error.message);
	assert.equal(fake.creates(), 0);
});

test("the constructor refuses a dial host with exec or upload", () => {
	const dialFacts = { connect: "dial", lifetime: "vendor" };
	const host = fakeHost({ facts: dialFacts }).host;
	assert.throws(() => new HostedProvider({ ...host, exec: fakeHost().host.exec }, { daemonPath: DAEMON_PATH }), /dial this server \(facts.connect "dial"\), so its host has no exec and no upload/);
	assert.throws(() => new HostedProvider({ ...host, upload: async () => {} }, { daemonPath: DAEMON_PATH }), /has no exec and no upload/);
});

test("a dial desktop boots init with DISPLAY and --window-manager, starts the X server over the socket it dialed, waits until computerd's window manager runs, and declares the screen", async () => {
	const { fake, provider, hub } = setup({ facts: { windowManager: true } }, { kind: "desktop" });
	const ref = made(await create(provider));
	const [, request] = fake.calls.find(([what]) => what === "create");
	assert.equal(request.boot.env.DISPLAY, ":0");
	assert.equal(fake.machines.get(ref.id).init.display, ":0", "init started with the display");
	assert.deepEqual(fake.events.filter(({ what }) => what.startsWith("run ")), [], "nothing was run in the machine through the host");
	assert.deepEqual(fake.uploads, [], "and nothing uploaded");
	assert.match(request.boot.env.AGENTRUN_INIT_ARGS, / --window-manager$/, "init is asked to start the window manager");
	assert.equal(fake.machines.get(ref.id).init.windowManager, true);
	// The X server alone, started by computerd as any program, over the socket the machine dialed: computerd starts the
	// window manager itself.
	assert.deepEqual(
		fake.machines.get(ref.id).processes.map(({ argv }) => argv[0]),
		["Xvfb"],
	);
	const connection = made(await provider.connect(ref));
	assert.equal(connection.hello.kind, "desktop");
	assert.ok(connection.hello.groups.includes("screen"));
	assert.deepEqual(connection.hello.windowManager, { state: "running" });
	await connection.close();
	assert.equal(hub.online(ref.name), true);
	made(await provider.release(ref, "delete"));
	assert.deepEqual(fake.live(), []);
});

const LINUX_HELLO = { protocol: mintedComputer("computer-5f3a9c1e7b2d", { kind: "linux", os: "linux", arch: "amd64" }).hello.protocol, version: "0.1.0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
const MINTED_WORDS = (kind) => new RegExp(`^computer-5f3a9c1e7b2d was made a linux ${kind} on amd64 and says .*: its token is that machine's alone$`);

test("a minted machine's hello of another kind, os or arch is closed 4400 in a machine's words; a paired Mac's arch may change", () => {
	const minted = mintedComputer("computer-5f3a9c1e7b2d", { kind: "linux", os: "linux", arch: "amd64" });
	assert.equal(helloMismatch(minted, LINUX_HELLO), undefined);
	for (const other of [{ arch: "arm64" }, { kind: "desktop" }, { os: "windows" }]) {
		const wrong = helloMismatch(minted, { ...LINUX_HELLO, ...other });
		assert.equal(wrong?.code, ATTACH_CLOSE.mismatch, JSON.stringify(other));
		assert.match(wrong.message, MINTED_WORDS("linux"));
	}
	// A paired computer's driver may move from amd64 (under Rosetta) to arm64: the same computer.
	const paired = { id: "c-1", name: "Test Mac", hello: { ...LINUX_HELLO, os: "macos", kind: "desktop", groups: ["screen", "input.pointer", "input.keys", "apps", "ui"] }, labels: {} };
	assert.equal(helloMismatch(paired, { ...paired.hello, arch: "arm64" }), undefined);
});

test("a machine minted a desktop that says linux, as it does until its display answers, is let in", () => {
	const desktop = mintedComputer("computer-5f3a9c1e7b2d", { kind: "desktop", os: "linux", arch: "amd64" });
	assert.equal(helloMismatch(desktop, LINUX_HELLO), undefined);
	assert.equal(helloMismatch(desktop, { ...LINUX_HELLO, kind: "desktop", groups: [...LINUX_HELLO.groups, "screen", "input.pointer", "input.keys", "apps"] }), undefined, "and once it says desktop");
});

test("the linux exception is a minted desktop's alone, on its own os and arch: a minted linux saying desktop, a minted desktop elsewhere or of another kind, and a paired desktop saying linux are closed 4400", () => {
	const desktop = mintedComputer("computer-5f3a9c1e7b2d", { kind: "desktop", os: "linux", arch: "amd64" });
	for (const other of [{ arch: "arm64" }, { os: "windows" }, { os: "android", kind: "linux" }, { kind: "android" }]) {
		const wrong = helloMismatch(desktop, { ...LINUX_HELLO, ...other });
		assert.equal(wrong?.code, ATTACH_CLOSE.mismatch, JSON.stringify(other));
		assert.match(wrong.message, MINTED_WORDS("desktop"));
	}
	const linux = mintedComputer("computer-5f3a9c1e7b2d", { kind: "linux", os: "linux", arch: "amd64" });
	assert.match(helloMismatch(linux, { ...LINUX_HELLO, kind: "desktop" })?.message ?? "", MINTED_WORDS("linux"));
	// A paired computer (never minted) keeps both kind checks: a paired linux desktop that says linux pairs again.
	const paired = { id: "c-2", name: "Test Box", hello: { ...LINUX_HELLO, kind: "desktop" }, labels: {} };
	const again = helloMismatch(paired, LINUX_HELLO);
	assert.equal(again?.code, ATTACH_CLOSE.mismatch);
	assert.equal(again.message, "Test Box paired as a linux desktop on amd64 and now says linux linux on amd64: pair it again");
});

test("a dial desktop whose display is down fails connect and watch as drift, as on exec; once it answers again, connect is a desktop's", async () => {
	const { fake, provider } = setup({ facts: { windowManager: true } }, { kind: "desktop" });
	const ref = made(await create(provider));
	// Its display goes (an X server that died): its hello says linux.
	const m = fake.machines.get(ref.id);
	m.xvfb = undefined;
	m.displayUp = false;
	const refused = await provider.connect(ref);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "refused");
	assert.match(refused.error.message, /does not match this provider: hello: the daemon reports kind linux, expected desktop/);
	const watched = await provider.watch(ref, { frame() {}, ended() {} });
	assert.equal(watched.ok, false);
	assert.match(watched.error.message, /does not match this provider: hello: the daemon reports kind linux, expected desktop/);
	assert.ok(!fake.requests.some(({ method }) => method === "screen.watch"), "no watch was sent");
	// Once its display answers again, the next connect is a desktop's.
	m.displayUp = true;
	const up = made(await provider.connect(ref));
	assert.equal(up.hello.kind, "desktop");
	await up.close();
	made(await provider.release(ref, "delete"));
	assert.deepEqual(fake.live(), []);
});

for (const kind of ["linux", "desktop"]) {
	test(`Core's provider cases pass over a dial host's ${kind}, provider.dial-token among them, and leave nothing behind`, { timeout: 60_000 }, async () => {
		const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
		const { fake, provider, kit } = setup({ facts: { windowManager: true } }, { kind });
		// Not provider.deadline or drift.arch: they run programs, which the fake host's daemon only echoes (as the packed host's run).
		const cases = conformanceCases.filter((one) => ["provider", "health", "drift"].includes(one.group) && one.level === "core" && !["provider.deadline", "drift.arch"].includes(one.id));
		const report = await runConformance(provider, { image: "img", cases, dial: kit, caseTimeoutMs: 20_000, cleanupTimeoutMs: 5_000 });
		assert.equal(report.results.find(({ id }) => id === "provider.dial-token")?.status, "pass", JSON.stringify(report.results.find(({ id }) => id === "provider.dial-token")));
		assert.deepEqual(
			report.results.filter(({ status }) => status === "fail").map(({ id, reason }) => `${id}: ${reason}`),
			[],
		);
		assert.deepEqual(fake.live(), [], "every machine made was deleted");
	});
}

test("provider.dial-token is said and passes for a host with exec, and fails a dial host's run given no server", async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const only = conformanceCases.filter(({ id }) => id === "provider.dial-token");
	const exec = await runConformance(new HostedProvider(fakeHost().host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }), { image: "img", cases: only });
	assert.deepEqual(exec.results.map(({ status, observed }) => [status, observed]), [["pass", ["the provider's machines do not dial the server, so they hold no machine token"]]]);
	const dial = await runConformance(setup().provider, { image: "img", cases: only });
	assert.deepEqual(dial.results.map(({ status, reason }) => [status, reason]), [["fail", "the provider's machines dial the server, and the run was given no server for them: a conformance module exports dialKit() (ConformanceOptions.dial)"]]);
});
