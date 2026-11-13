// The E2B network diagnostic (dist/conformance/e2b-diagnose.js) against the fake E2B SDK (test/fake-e2b.mjs): it makes
// one sandbox as the provider makes one for network none, runs `computerd probe --diagnose` in it, prints one JSON line,
// and always kills the sandbox and reads it back gone: after a diagnosis, a failed probe, a drift the provider refuses,
// and an abort. No SDK is loaded, no key is read from the environment and nothing reaches the network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DAEMON, fakeE2B, KEY } from "./fake-e2b.mjs";

const COMPUTER = "agentrun.computer";
const LIVE = "AGENTRUN_COMPUTER_LIVE_E2B";
const ENV = { COMPUTER_E2B_API_KEY: KEY, [LIVE]: "1" };
const dir = mkdtempSync(join(tmpdir(), "computer-e2b-diagnose-"));
const DAEMON_PATH = join(dir, "computerd");
const DAEMON_BYTES = Buffer.from("a stand-in for computerd, linux/amd64, for the diagnostic\n");
writeFileSync(DAEMON_PATH, DAEMON_BYTES);
const SHA = createHash("sha256").update(DAEMON_BYTES).digest("hex");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500 };

/** What `computerd probe --diagnose` prints in a sandbox whose firewall accepts every TCP connection and answers none. */
const ACCEPT_ONLY = {
	uid: 1000,
	gid: 1000,
	kernel: "6.1.102",
	verdict: "accepted-only",
	results: [
		{ target: "1.1.1.1", port: 443, proto: "tcp", probe: "tls", name: "one.one.one.one", outcome: "accepted", bytes: 0, detail: "the connection closed with no bytes" },
		{ target: "1.1.1.1", port: 53, proto: "udp", probe: "dns", outcome: "refused", bytes: 0, detail: "no answer within 3 s" },
	],
};

function sink() {
	const stream = {
		text: "",
		write(text, done) {
			stream.text += text;
			done?.();
			return true;
		},
	};
	return stream;
}

async function diagnose(fake, { env = ENV, argv = [], signal } = {}) {
	const stdout = sink();
	const stderr = sink();
	const { main } = await import("../dist/conformance/e2b-diagnose.js");
	const code = await main(argv, { env, Sandbox: fake.Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, stdout, stderr, ...(signal ? { signal } : {}) });
	return { code, stdout: stdout.text, stderr: stderr.text };
}

const reportOf = (stdout) => {
	assert.equal(stdout.split("\n").filter(Boolean).length, 1, `one JSON line: ${stdout}`);
	return JSON.parse(stdout);
};
const only = (fake) => {
	assert.equal(fake.sandboxes.size, 1, "one sandbox was made");
	return [...fake.sandboxes.values()][0];
};
/** The sandbox was killed and E2B reads it gone: getInfo no longer finds it and the label listing no longer shows it. */
async function assertGone(fake) {
	const sb = only(fake);
	assert.deepEqual(fake.kills, [sb.id], "the sandbox was killed");
	await assert.rejects(fake.Sandbox.getInfo(sb.id, {}), { name: "SandboxNotFoundError" });
	const page = await fake.Sandbox.list({ query: { metadata: { [COMPUTER]: "1" } } }).nextItems({});
	assert.deepEqual(page, [], "the listing no longer shows it");
}
const execs = (fake) => fake.requests.filter(({ method }) => method === "exec.run").map(({ params }) => params.argv);

test("it refuses without AGENTRUN_COMPUTER_LIVE_E2B=1, before any setting is read or any call is made", async () => {
	for (const env of [{ COMPUTER_E2B_API_KEY: KEY }, { COMPUTER_E2B_API_KEY: KEY, [LIVE]: "0" }, {}]) {
		const fake = fakeE2B();
		const { code, stdout, stderr } = await diagnose(fake, { env });
		assert.equal(code, 2);
		assert.equal(stdout, "");
		assert.match(stderr, /AGENTRUN_COMPUTER_LIVE_E2B=1/);
		assert.deepEqual(fake.calls, [], "no SDK call");
	}
});

test("it makes one sandbox as the provider makes one for network none, with a 10-minute E2B timeout, and reads it back", async () => {
	const fake = fakeE2B({ box: { diagnosis: ACCEPT_ONLY } });
	const { code, stdout, stderr } = await diagnose(fake);
	assert.equal(code, 0, stderr);
	const sb = only(fake);
	const [, template, opts] = fake.calls.find(([name]) => name === "Sandbox.create");
	assert.equal(template, "desktop");
	assert.equal(opts.timeoutMs, 600_000, "E2B ends the sandbox at 10 minutes whatever happens here");
	assert.equal(opts.allowInternetAccess, false);
	assert.deepEqual(opts.network, { allowPublicTraffic: false });
	assert.deepEqual(opts.lifecycle, { onTimeout: "kill" });
	assert.deepEqual(opts.envs, {});
	assert.equal(opts.apiKey, KEY);
	assert.equal(opts.metadata[COMPUTER], "1");
	assert.equal(opts.metadata[`${COMPUTER}.timeout-ms`], "600000");
	assert.ok(fake.names().indexOf("Sandbox.getInfo") > fake.names().indexOf("Sandbox.create"), "the network is read back after create");
	assert.deepEqual(fake.uploads.map(({ sandbox, user }) => [sandbox, user]), [[sb.id, "root"]]);
	assert.equal(createHash("sha256").update(sb.daemon.bytes).digest("hex"), SHA, "the daemon's upload is sha-checked as at create");
	const report = reportOf(stdout);
	assert.equal(report.template, "desktop");
	assert.deepEqual(report.computer, { id: sb.id, name: sb.metadata[`${COMPUTER}.name`] });
	assert.deepEqual(report.readBack, { allowInternetAccess: false, allowPublicTraffic: false, denyOut: ["0.0.0.0/0"] });
	assert.deepEqual(report.diagnosis, ACCEPT_ONLY);
	assert.equal(report.released.gone, true);
	await assertGone(fake);
});

test("it runs the provider's own network-none check and then probe --diagnose, and records the check's refusal without relaxing it", async () => {
	const fake = fakeE2B({ box: { diagnosis: ACCEPT_ONLY, reached: ["1.1.1.1:443", "8.8.8.8:443"] } });
	const { code, stdout } = await diagnose(fake);
	assert.equal(code, 0);
	const argvs = execs(fake);
	assert.deepEqual(argvs.at(-1), [DAEMON, "probe", "--diagnose"]);
	assert.ok(argvs.some((argv) => argv[1] === "probe" && argv[2] === "--connect"), "the provider's --connect probe ran first");
	const report = reportOf(stdout);
	assert.match(report.check, /network: declared none, read back an answer from 1\.1\.1\.1:443, 8\.8\.8\.8:443/);
	assert.deepEqual(report.diagnosis, ACCEPT_ONLY);
	await assertGone(fake);

	// The provider itself still refuses that sandbox, exactly as before.
	const { E2BProvider } = await import("../dist/e2b.js");
	const again = fakeE2B({ box: { diagnosis: ACCEPT_ONLY, reached: ["1.1.1.1:443"] } });
	const provider = new E2BProvider({ apiKey: KEY, Sandbox: again.Sandbox, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const made = await provider.create({ image: "desktop", lifetimeMs: 600_000, network: "none" });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /read back an answer from 1\.1\.1\.1:443/);
	assert.ok(!execs(again).some((argv) => argv[2] === "--diagnose"), "create never runs the diagnostic");
});

test("a probe that fails or writes what is not its report still ends with the sandbox killed and read back gone", async () => {
	for (const box of [{ diagnose: "fails" }, { diagnose: "garbage" }]) {
		const fake = fakeE2B({ box });
		const { code, stdout } = await diagnose(fake);
		assert.equal(code, 1, JSON.stringify(box));
		const report = reportOf(stdout);
		assert.equal(report.diagnosis, undefined);
		assert.match(report.error.message, /probe --diagnose/);
		assert.equal(report.released.gone, true);
		await assertGone(fake);
	}
});

test("a sandbox the provider refuses at its read-back or its daemon's sha256 is never probed, and is killed and read back gone", async () => {
	for (const [options, pattern] of [
		[{ info: { allowInternetAccess: true, network: { allowPublicTraffic: false } } }, /network: declared none, read back open/],
		[{ sha: "lie" }, /sha256/],
	]) {
		const fake = fakeE2B({ ...options, box: { diagnosis: ACCEPT_ONLY } });
		const { code, stdout } = await diagnose(fake);
		assert.equal(code, 1);
		const report = reportOf(stdout);
		assert.equal(report.error.code, "refused");
		assert.match(report.error.message, pattern);
		assert.equal(report.diagnosis, undefined);
		assert.ok(!execs(fake).some((argv) => argv[2] === "--diagnose"), "no diagnostic ran");
		await assertGone(fake);
	}
});

test("an abort at any step, the create's included, still kills the sandbox and reads it back gone", async () => {
	for (const at of ["Sandbox.create", "Sandbox.getInfo", "files.write", "commands.run install", "hello", "exec.run"]) {
		const controller = new AbortController();
		let hit = false;
		const fake = fakeE2B({
			box: { diagnosis: ACCEPT_ONLY },
			onStep: (step) => {
				if (step === at && !hit) {
					hit = true;
					controller.abort();
				}
			},
		});
		const { code, stdout } = await diagnose(fake, { signal: controller.signal });
		assert.ok(hit, `${at} was reached`);
		assert.equal(code, 1, at);
		const report = reportOf(stdout);
		assert.equal(report.error.code, "aborted", `${at}: ${JSON.stringify(report.error)}`);
		assert.equal(report.released.gone, true, `${at}: ${report.released.words}`);
		await assertGone(fake);
	}
});

test("a create E2B refuses makes nothing, and the report says so", async () => {
	const fake = fakeE2B({ create: "fail" });
	const { code, stdout } = await diagnose(fake);
	assert.equal(code, 1);
	const report = reportOf(stdout);
	assert.equal(report.error.code, "invalid");
	assert.equal(report.computer, undefined);
	assert.deepEqual(fake.kills, []);
});

test("a sandbox that will not read back gone is reported, with a non-zero exit", async () => {
	const fake = fakeE2B({ box: { diagnosis: ACCEPT_ONLY }, lingers: { reads: 1_000 } });
	const { code, stdout } = await diagnose(fake);
	assert.equal(code, 1);
	const report = reportOf(stdout);
	assert.deepEqual(report.diagnosis, ACCEPT_ONLY);
	assert.equal(report.released.gone, false);
	assert.match(report.released.words, /running/);
});

test("the key is never printed, COMPUTER_E2B_TEMPLATE names the template, and it takes no argument", async () => {
	const fake = fakeE2B({ box: { diagnosis: ACCEPT_ONLY } });
	const { code, stdout, stderr } = await diagnose(fake, { env: { ...ENV, COMPUTER_E2B_TEMPLATE: "base", COMPUTER_E2B_KIND: "linux" } });
	assert.equal(code, 0, stderr);
	assert.equal(fake.calls.find(([name]) => name === "Sandbox.create")[1], "base");
	assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY), "the key is in neither output");
	const bad = fakeE2B();
	const refused = await diagnose(bad, { argv: ["--connect", "example.com:443"] });
	assert.equal(refused.code, 2);
	assert.match(refused.stderr, /usage/);
	assert.deepEqual(bad.calls, [], "no SDK call");
});
