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
import { ATTACH_CLOSE, AttachHub, helloMismatch, hostedDaemonPath, MemoryMachineTokens, mintedComputer } from "../dist/index.js";
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
	assert.match(env.AGENTRUN_ATTACH_TOKEN, /^art_[0-9a-f]{64}$/);
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
	assert.match(refused.error.message, /mount: Fakehost's machines dial this server, and a machine that dials takes no Archil mount yet/);
	assert.equal(fake.creates(), 0);
});

test("the constructor refuses a dial host with exec or upload, or for a desktop", () => {
	const dialFacts = { connect: "dial", lifetime: "vendor" };
	const host = fakeHost({ facts: dialFacts }).host;
	assert.throws(() => new HostedProvider({ ...host, exec: fakeHost().host.exec }, { daemonPath: DAEMON_PATH }), /dial this server \(facts.connect "dial"\), so its host has no exec and no upload/);
	assert.throws(() => new HostedProvider({ ...host, upload: async () => {} }, { daemonPath: DAEMON_PATH }), /has no exec and no upload/);
	assert.throws(() => new HostedProvider(host, { daemonPath: DAEMON_PATH, kind: "desktop" }), /agentrun-dial starts init with no display: make it kind linux/);
});

test("a minted machine's hello of another kind, os or arch is closed 4400 in a machine's words; a paired computer's arch may change", () => {
	const minted = mintedComputer("computer-5f3a9c1e7b2d", { kind: "linux", os: "linux", arch: "amd64" });
	const hello = { protocol: minted.hello.protocol, version: "0.1.0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
	assert.equal(helloMismatch(minted, hello), undefined);
	for (const other of [{ arch: "arm64" }, { kind: "desktop" }, { os: "windows" }]) {
		const wrong = helloMismatch(minted, { ...hello, ...other });
		assert.equal(wrong?.code, ATTACH_CLOSE.mismatch, JSON.stringify(other));
		assert.match(wrong.message, /^computer-5f3a9c1e7b2d was made a linux linux on amd64 and says .*: its token is that machine's alone$/);
	}
	// A paired computer's driver may move from amd64 (under Rosetta) to arm64: the same computer.
	const paired = { id: "c-1", name: "Test Mac", hello: { ...hello, os: "macos", kind: "desktop", groups: ["screen", "input.pointer", "input.keys", "apps", "ui"] }, labels: {} };
	assert.equal(helloMismatch(paired, { ...paired.hello, arch: "arm64" }), undefined);
});

test("Core's provider cases pass over a dial host, provider.dial-token among them, and leave nothing behind", { timeout: 60_000 }, async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const { fake, provider, kit } = setup();
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

test("provider.dial-token is said and passes for a host with exec, and fails a dial host's run given no server", async () => {
	const { conformanceCases, runConformance } = await import("../dist/conformance/index.js");
	const only = conformanceCases.filter(({ id }) => id === "provider.dial-token");
	const exec = await runConformance(new HostedProvider(fakeHost().host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }), { image: "img", cases: only });
	assert.deepEqual(exec.results.map(({ status, observed }) => [status, observed]), [["pass", ["the provider's machines do not dial the server, so they hold no machine token"]]]);
	const dial = await runConformance(setup().provider, { image: "img", cases: only });
	assert.deepEqual(dial.results.map(({ status, reason }) => [status, reason]), [["fail", "the provider's machines dial the server, and the run was given no server for them: a conformance module exports dialKit() (ConformanceOptions.dial)"]]);
});
