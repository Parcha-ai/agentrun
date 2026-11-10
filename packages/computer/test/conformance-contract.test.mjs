// The contract cases (health.declared, health.no-key-in-errors), the protocol version in hello, and the published spec
// (spec/computer) against the code. Fakes only: no network, no vendor, no wall clock.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { conformanceCases, formatReport, runConformance } from "../dist/index.js";
import { PROTOCOL_VERSION } from "../dist/protocol.js";
import { fakePhoneHarness, KEY } from "./fake-phone-harness.mjs";

const { create, memoryLedger } = await import("../dist/phone-harness.js");
const caseOf = (id) => conformanceCases.find((one) => one.id === id);
const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasonOf = (report, id) => report.results.find((r) => r.id === id)?.reason ?? "";

/** The least of a case's context these two cases use: a failed assertion throws, a skip throws its reason. */
function context({ hello, capabilities, declared, planted }) {
	class Skip extends Error {}
	const t = {
		hello,
		declared,
		provider: { capabilities: () => capabilities },
		signal: new AbortController().signal,
		runLabels: { "agentrun.conformance": "contract-test" },
		spec: (extra = {}) => ({ image: "android", lifetimeMs: 60_000, network: "none", labels: { "agentrun.conformance": "contract-test" }, ...extra }),
		attempt: (spec, by) => by.create(spec),
		async planted() {
			if (planted === undefined) throw new Skip("no planted provider");
			return planted;
		},
		assert(condition, what) {
			if (!condition) throw new Error(what);
		},
		equal(actual, expected, what) {
			if (actual !== expected) throw new Error(`${what}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
		},
		skip(reason) {
			throw new Skip(reason);
		},
	};
	return { t, Skip };
}

const ANDROID = { kind: "android", os: "android", daemon: "none", groups: ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"], network: ["open"] };
const HELLO = { protocol: PROTOCOL_VERSION, version: "1", os: "android", kind: "android", arch: "amd64", groups: ANDROID.groups };

test("health.declared: hello carries this protocol's version, and capabilities() is one of the configurations declared", async () => {
	const declared = caseOf("health.declared");
	assert.equal(declared.level, "core");
	const agree = context({ hello: HELLO, capabilities: ANDROID, declared: [{ kind: "android", groups: [...ANDROID.groups].reverse() }] });
	await declared.run(agree.t);

	const old = context({ hello: { ...HELLO, protocol: undefined }, capabilities: ANDROID, declared: [{ kind: "android", groups: ANDROID.groups }] });
	await assert.rejects(declared.run(old.t), /hello carries the protocol version this suite speaks, 0\.1: undefined/);
	const other = context({ hello: { ...HELLO, protocol: "9.0" }, capabilities: ANDROID, declared: [{ kind: "android", groups: ANDROID.groups }] });
	await assert.rejects(declared.run(other.t), /protocol version.*"9\.0"/);

	const drifted = context({ hello: HELLO, capabilities: ANDROID, declared: [{ kind: "android", groups: ["screen", "input.touch", "apps"] }] });
	await assert.rejects(declared.run(drifted.t), /capabilities\(\), kind android \[.*\], is one of the configurations the provider declares: android \[screen, input\.touch, apps\]/);

	const none = context({ hello: HELLO, capabilities: ANDROID, declared: undefined });
	await assert.rejects(declared.run(none.t), (error) => error instanceof none.Skip && /no declaration of the provider/.test(error.message));
});

/** A provider whose every call answers in words, built from what each call should say. */
function wordy(say) {
	const no = (call) => ({ ok: false, error: { code: "denied", message: say(call) } });
	return {
		id: "wordy",
		version: "1",
		capabilities: () => ANDROID,
		check: () => [],
		testConnection: async () => ({ ok: false, error: { code: "unauthorized", message: say("testConnection") } }),
		list: async () => no("list"),
		attach: async () => no("attach"),
		network: async () => no("network"),
		connect: async () => no("connect"),
		release: async () => no("release"),
		create: async () => no("create"),
	};
}

test("health.no-key-in-errors: every refusal path is asked, and a planted key in any answer, whole or cut short, fails the case", async () => {
	const noKey = caseOf("health.no-key-in-errors");
	assert.equal(noKey.level, "core");
	assert.deepEqual(noKey.needs, ["secrets"], "a provider that takes no secret skips it as undeclared");
	const secret = "agentrun-planted-0123456789abcdef01234567";
	const asked = [];
	const clean = context({ hello: HELLO, capabilities: ANDROID, planted: { provider: wordy((call) => (asked.push(call), `${call}: the vendor refused the key`)), secrets: [secret] } });
	await noKey.run(clean.t);
	assert.deepEqual(asked, ["testConnection", "list", "attach", "attach", "network", "connect", "release", "create"], "every refusal path was asked");

	for (const [leak, words] of [
		[(call) => `${call}: the key ${secret} was refused`, "whole"],
		[(call) => `${call}: the key …${secret.slice(-12)} was refused`, "its last 12 characters"],
	]) {
		const leaky = context({ hello: HELLO, capabilities: ANDROID, planted: { provider: wordy(leak), secrets: [secret] } });
		await assert.rejects(noKey.run(leaky.t), /testConnection: what the provider answered holds none of a planted secret/, words);
	}
	// A throw is an answer too: its words are read.
	const throwing = { ...wordy(() => "no"), list: async () => { throw new Error(`list failed for ${secret}`); } };
	const thrown = context({ hello: HELLO, capabilities: ANDROID, planted: { provider: throwing, secrets: [secret] } });
	await assert.rejects(noKey.run(thrown.t), /list: what the provider answered holds none of a planted secret/);
});

test("the phone harness passes both contract cases through the runner: its PROVIDERS entry is its declaration, and a planted key never comes back", { timeout: 120_000 }, async () => {
	const fake = fakePhoneHarness();
	const options = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: fake.clock.now, sleep: fake.clock.sleep, maxLifetimeMs: 10 * 60_000 };
	const provider = await create(options);
	const secret = "agentrun-planted-fedcba9876543210fedcba98";
	const planted = async () => ({ provider: await create({ ...options, apiKey: secret }), secrets: [secret] });
	const ids = ["health.hello", "health.declared", "health.no-key-in-errors"];
	const report = await runConformance(provider, { image: "android", patience: 5000, planted, cases: conformanceCases.filter((one) => ids.includes(one.id)) });
	for (const id of ids) assert.equal(statuses(report)[id], "pass", `${id}: ${reasonOf(report, id)}\n${formatReport(report)}`);
	// Without a planted provider, the no-key case is skipped as undeclared: not part of Core's verdict.
	const bare = await runConformance(await create({ ...options, ledger: memoryLedger() }), { image: "android", patience: 5000, cases: conformanceCases.filter((one) => ids.includes(one.id)) });
	assert.equal(statuses(bare)["health.no-key-in-errors"], "skip");
	assert.deepEqual(bare.results.find((r) => r.id === "health.no-key-in-errors").undeclared, ["secrets"]);
});

test("helloDrift refuses a daemon that speaks another protocol version; one with none is left to the version check", async () => {
	const { helloDrift } = await import("../dist/drift.js");
	const expected = { version: "1.2.3", kind: "linux", groups: ["exec", "files", "processes"] };
	const hello = { protocol: PROTOCOL_VERSION, version: "1.2.3", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
	assert.deepEqual(helloDrift(hello, expected), []);
	assert.deepEqual(helloDrift({ ...hello, protocol: "9.0" }, expected), [`hello: the daemon speaks protocol 9.0, expected ${PROTOCOL_VERSION}`]);
	const { protocol: _protocol, ...older } = hello;
	assert.deepEqual(helloDrift(older, expected), [], "no protocol: no protocol words of its own");
});

test("spec/computer matches protocol.ts, and computerd's protocol version is the TypeScript side's", async () => {
	const root = new URL("../../../", import.meta.url).pathname;
	const checked = await new Promise((resolve) => execFile(process.execPath, ["scripts/generate-computer-spec.mjs", "--check"], { cwd: root, timeout: 120_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
	assert.equal(checked.error, null, `${checked.stdout}${checked.stderr}`);
	const constants = JSON.parse(readFileSync(new URL("../../../spec/computer/protocol.json", import.meta.url), "utf8"));
	assert.equal(constants.protocolVersion, PROTOCOL_VERSION);
	const go = readFileSync(new URL("../daemon/internal/methods/methods.go", import.meta.url), "utf8");
	assert.equal(/const ProtocolVersion = "([^"]+)"/.exec(go)?.[1], PROTOCOL_VERSION, "computerd's ProtocolVersion is PROTOCOL_VERSION");
});
