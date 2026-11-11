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
function context({ hello, capabilities, declared, planted, kept = true }) {
	class Skip extends Error {}
	const t = {
		hello,
		declared,
		ref: CASE_REF,
		// The case's own provider, with the real key: its computer is still there, or (kept false) a planted release let it go.
		provider: { capabilities: () => capabilities, attach: async ({ id }) => (kept && id === CASE_REF.id ? { ok: true, value: { ref: CASE_REF } } : { ok: false, error: { code: "not_found", message: `no computer ${id}` } }) },
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

/** The case's computer: a real one of the provider's, so each path that takes a ref reaches the vendor. */
const CASE_REF = { id: "phone-0123abcd", name: "computer-0123456789ab" };
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
function wordy(say, refs = []) {
	const no = (call) => ({ ok: false, error: { code: "denied", message: say(call) } });
	return {
		id: "wordy",
		version: "1",
		capabilities: () => ANDROID,
		check: () => [],
		testConnection: async () => ({ ok: false, error: { code: "unauthorized", message: say("testConnection") } }),
		list: async () => no("list"),
		attach: async (target) => (refs.push(["attach", target.id ?? "labels"]), no("attach")),
		network: async (ref) => (refs.push(["network", ref.id]), no("network")),
		connect: async (ref) => (refs.push(["connect", ref.id]), no("connect")),
		release: async (ref) => (refs.push(["release", ref.id]), no("release")),
		create: async () => no("create"),
	};
}

test("health.no-key-in-errors: every refusal path is asked, and a planted key in any answer, whole or cut short, fails the case", async () => {
	const noKey = caseOf("health.no-key-in-errors");
	assert.equal(noKey.level, "core");
	assert.deepEqual(noKey.needs, ["secrets"], "a provider that takes no secret skips it as undeclared");
	const secret = "agentrun-planted-0123456789abcdef01234567";
	const asked = [];
	const refs = [];
	const clean = context({ hello: HELLO, capabilities: ANDROID, planted: { provider: wordy((call) => (asked.push(call), `${call}: the vendor refused the key`), refs), secrets: [secret] } });
	await noKey.run(clean.t);
	assert.deepEqual(asked, ["testConnection", "list", "attach", "attach", "network", "connect", "release", "create"], "every refusal path was asked");
	// Each path that takes a ref is asked about the case's own computer, which the provider's shape checks pass, so the
	// planted secret reaches the vendor (review: a made-up ref was refused before it, as E2B's name check does).
	assert.deepEqual(refs, [["attach", CASE_REF.id], ["attach", "labels"], ["network", CASE_REF.id], ["connect", CASE_REF.id], ["release", CASE_REF.id]]);
	// A release with the planted secret that let the computer go fails the case.
	const gone = context({ hello: HELLO, capabilities: ANDROID, kept: false, planted: { provider: wordy(() => "refused"), secrets: [secret] } });
	await assert.rejects(noKey.run(gone.t), /the computer is still there after a release with a planted secret: not_found/);
	// A connect that succeeds with the planted secret and echoes it fails the case, and its connection is still closed.
	let closes = 0;
	const echoing = { ...wordy(() => "refused"), connect: async () => ({ ok: true, value: { hello: { leaked: secret }, close: async () => void (closes += 1) } }) };
	const leaked = context({ hello: HELLO, capabilities: ANDROID, planted: { provider: echoing, secrets: [secret] } });
	await assert.rejects(noKey.run(leaked.t), /connect: what the provider answered holds none of a planted secret/);
	assert.equal(closes, 1, "the connection the failed check found is closed");

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

test("the published schema refuses the params computerd refuses: a map's non-string value and an unknown field; hello and ping take any params, and results stay open", async () => {
	const { default: Ajv } = await import("ajv");
	const schema = JSON.parse(readFileSync(new URL("../../../spec/computer/schema/methods.schema.json", import.meta.url), "utf8"));
	const ajv = new Ajv({ strict: false, allErrors: true });
	ajv.addSchema(schema);
	const shape = (method, side) => ajv.compile({ $ref: `${schema.$id}#/definitions/DaemonMethods/properties/${method}/properties/${side}` });
	const valid = (method, side, value) => shape(method, side)(value);

	assert.equal(valid("exec.run", "params", { argv: ["true"], timeoutMs: 1000, env: { FOO: "bar" } }), true, "a well-formed exec.run");
	assert.equal(valid("exec.run", "params", { argv: ["true"], timeoutMs: 1000, env: { FOO: 123 } }), false, "env holds strings only");
	assert.equal(valid("exec.run", "params", { argv: ["true"], timeoutMs: 1000, shell: true }), false, "an unknown field");
	assert.equal(valid("files.read", "params", { path: "/workspace/notes.txt", extra: 1 }), false, "an unknown field");
	assert.equal(valid("apps.list", "params", {}), true, "no params");
	assert.equal(valid("apps.list", "params", { all: true }), false, "a method that takes no params refuses one");
	assert.equal(valid("input.actions", "params", { actions: [{ type: "move", at: [1, 2], speed: 3 }] }), false, "an action's unknown field");
	// The exceptions: hello and ping read no params, so a newer client's hello is never refused.
	assert.equal(valid("hello", "params", { client: "test", newer: true }), true);
	assert.equal(valid("ping", "params", { anything: 1 }), true);
	// A param's number is whole, as the daemon decodes it; a pixel scroll and a pinch's scale take fractions.
	assert.equal(valid("exec.run", "params", { argv: ["true"], timeoutMs: 1000.5 }), false, "a fractional timeoutMs");
	assert.equal(valid("files.read", "params", { path: "/workspace/notes.txt", offset: 1.5 }), false, "a fractional offset");
	assert.equal(valid("input.actions", "params", { actions: [{ type: "move", at: [1.5, 2] }] }), false, "a fractional point");
	assert.equal(valid("input.actions", "params", { actions: [{ type: "scroll", dx: 0.5, unit: "px" }] }), true, "a pixel scroll's fraction");
	assert.equal(valid("input.actions", "params", { actions: [{ type: "pinch", at: [1, 2], scale: 1.5 }] }), true, "a pinch's scale");
	// A result may carry a field a later minor version adds.
	assert.equal(valid("hello", "result", { protocol: PROTOCOL_VERSION, version: "1", os: "linux", kind: "linux", arch: "amd64", groups: ["exec"], later: 1 }), true);
});
