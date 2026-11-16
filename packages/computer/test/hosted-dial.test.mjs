// The dial host mode (src/host.ts facts.connect "dial", HostedOptions.dial) against the fake dial host
// (fake-dial-host.mjs): create mints the machine's token and boots it with env, waits for its socket in the hub, and
// reads it back over that socket; a server with no public address makes nothing; a machine that never dials is deleted;
// delete revokes the token; Core's provider cases, provider.dial-token among them, pass over it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATTACH_CLOSE, AttachHub, helloMismatch, MemoryMachineTokens, mintedComputer } from "../dist/index.js";
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

test("a server with no public https address refuses a dial create in words before the vendor is called", async () => {
	for (const url of [undefined, "", "http://agentrun.example.com", "not a url"]) {
		const { fake, provider } = setup({}, { dial: { url, tokens: new MemoryMachineTokens(), hub: new AttachHub() } });
		const refused = await create(provider);
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, "refused");
		assert.match(refused.error.message, NO_ADDRESS, String(url));
		assert.equal(fake.creates(), 0, `${url}: no create reached the vendor`);
	}
	const bare = new HostedProvider(fakeDialHost({ daemon: DAEMON_BYTES }).fake.host, { daemonPath: DAEMON_PATH });
	assert.match((await create(bare)).error.message, NO_ADDRESS, "a provider given no dial at all");
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

test("a dial host takes no Archil mount, in words, and declares none", async () => {
	const { fake, provider } = setup();
	assert.deepEqual(provider.capabilities().mount, []);
	const refused = await create(provider, { ...SPEC, mount: { kind: "archil", disk: "dsk-0123456789abcdef", region: "aws-us-east-1", folder: "agents/a/runs/r/work" } });
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /mount: Fakehost's machines dial this server, and a machine that dials takes no Archil mount yet/);
	assert.equal(fake.creates(), 0);
});

test("the constructor refuses a dial host with exec or upload, with labels kept in the machine, or for a desktop", () => {
	const dialFacts = { connect: "dial", lifetime: "vendor" };
	const host = fakeHost({ facts: dialFacts }).host;
	assert.throws(() => new HostedProvider({ ...host, exec: fakeHost().host.exec }, { daemonPath: DAEMON_PATH }), /dial this server \(facts.connect "dial"\), so its host has no exec and no upload/);
	assert.throws(() => new HostedProvider({ ...host, upload: async () => {} }, { daemonPath: DAEMON_PATH }), /has no exec and no upload/);
	assert.throws(() => new HostedProvider(fakeHost({ facts: { ...dialFacts, labels: "machine" } }).host, { daemonPath: DAEMON_PATH }), /keep no labels \(facts.labels "machine"\), which are read through exec/);
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
	const paired = { id: "c-1", name: "Test Mac", hello: { ...hello, os: "macos", kind: "desktop" }, labels: {} };
	assert.equal(helloMismatch(paired, { ...paired.hello, arch: "arm64", groups: ["screen", "input.pointer", "input.keys", "apps", "ui"] }), undefined);
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
	assert.deepEqual(dial.results.map(({ status, reason }) => [status, reason]), [["fail", "the provider's machines dial the server, and the run was given no server for them: pass ConformanceOptions.dial"]]);
});
