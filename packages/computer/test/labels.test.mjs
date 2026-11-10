// The run and epoch labels (src/labels.ts): the two names in one place, the run id rule, and a computer's epoch read from
// its labels; and no provider refuses them. An agent's computer's owner labels, and the tenure rule every check() shares
// (checkTenure): no provider here declares persistence, so each refuses an owner. No Docker, no vendor: each provider's
// check() runs on its fake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DaytonaProvider } from "../dist/daytona.js";
import {
	checkTenure,
	EPOCH_LABEL,
	epochOf,
	epochProblem,
	IDLE_TTL_LABEL,
	OWNER_LABEL,
	ownerLabels,
	ownerOf,
	ownerProblem,
	RUN_LABEL,
	runLabels,
	runLifetimeMs,
	runProblem,
} from "../dist/index.js";
import { ModalProvider } from "../dist/modal.js";
import { API, KEY } from "./fake-daytona.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { DAEMON_IMAGE, fakeModal } from "./fake-modal.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const dir = mkdtempSync(join(tmpdir(), "computer-labels-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the labels are agentrun.run and agentrun.epoch, outside the providers' own agentrun.computer namespace", () => {
	assert.equal(RUN_LABEL, "agentrun.run");
	assert.equal(EPOCH_LABEL, "agentrun.epoch");
	for (const label of [RUN_LABEL, EPOCH_LABEL]) assert.ok(!label.startsWith("agentrun.computer"), label);
});

test("runLabels(run, epoch) gives the run's label and the epoch's, in decimal", () => {
	assert.deepEqual(runLabels("run-1", 3), { "agentrun.run": "run-1", "agentrun.epoch": "3" });
	assert.deepEqual(runLabels("r", 0), { "agentrun.run": "r", "agentrun.epoch": "0" });
	assert.deepEqual(runLabels("r", Number.MAX_SAFE_INTEGER), { "agentrun.run": "r", "agentrun.epoch": "9007199254740991" });
});

test("runLabels refuses a run that is not a run id, or an epoch that is not one, in words", () => {
	assert.throws(() => runLabels("", 1), /run id must be a non-empty string/);
	assert.throws(() => runLabels("a\0b", 1), /NUL/);
	assert.throws(() => runLabels(7, 1), /run id must be a non-empty string/);
	for (const epoch of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
		assert.throws(() => runLabels("r", epoch), /epoch must be a whole number from 0 to 9007199254740991/, String(epoch));
	}
});

test("runProblem and epochProblem name what is wrong, or give undefined", () => {
	assert.equal(runProblem("run-1"), undefined);
	assert.equal(runProblem("a run with spaces = and / signs"), undefined, "providers refuse only NUL in a label value");
	assert.match(runProblem(""), /non-empty/);
	assert.match(runProblem("a\0b"), /NUL/);
	assert.match(runProblem(null), /non-empty string/);
	assert.equal(epochProblem(0), undefined);
	assert.equal(epochProblem(12), undefined);
	assert.match(epochProblem(-1), /whole number from 0/);
	assert.match(epochProblem(2 ** 53), /whole number from 0/);
});

test("epochOf reads a decimal epoch with no sign, leading zero or space", () => {
	for (const [text, epoch] of [
		["0", 0],
		["1", 1],
		["42", 42],
		["9007199254740991", Number.MAX_SAFE_INTEGER],
	]) {
		assert.deepEqual(epochOf({ [EPOCH_LABEL]: text, other: "x" }), { ok: true, value: epoch }, text);
	}
});

test("epochOf reports anything else as no epoch, in words naming the label and what it reads", () => {
	for (const text of ["", "01", "00", "+1", "-1", " 1", "1 ", "1.0", "1e3", "0x1", "9007199254740992", "١", "one", "1\n"]) {
		const read = epochOf({ [EPOCH_LABEL]: text });
		assert.equal(read.ok, false, JSON.stringify(text));
		assert.equal(read.error.code, "invalid", JSON.stringify(text));
		assert.ok(read.error.message.includes(`the label ${EPOCH_LABEL} reads ${JSON.stringify(text)}`), read.error.message);
	}
	const missing = epochOf({ [RUN_LABEL]: "r" });
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, "not_found");
	assert.equal(missing.error.message, `the computer carries no ${EPOCH_LABEL} label`);
	for (const labels of [undefined, null, "agentrun.epoch=1", []]) {
		const read = epochOf(labels);
		assert.equal(read.ok, false, JSON.stringify(labels));
	}
});

/** Each provider's check(), on its fake: no vendor call is made. */
function providers() {
	const daemon = join(dir, "computerd");
	writeFileSync(daemon, "a stand-in for computerd\n");
	return [
		["docker", fakeDocker().provider],
		["daytona", new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: daemon, fetch: async () => assert.fail("no request") })],
		["modal", new ModalProvider({ sdk: fakeModal().sdk, app: "computers", daemonImage: DAEMON_IMAGE })],
	];
}

test("no provider refuses the run and epoch labels, beside a caller's own", () => {
	for (const [id, provider] of providers()) {
		const labels = { ...runLabels("run-7f3a", 12), "agentrun.conformance": "c1", role: "a" };
		const refusals = provider.check({ ...SPEC, labels });
		assert.deepEqual(
			refusals.filter((r) => r.field === "labels"),
			[],
			`${id}: ${JSON.stringify(refusals)}`,
		);
	}
});

test("an agent's computer carries agentrun.owner=agent:<id>, and its idle TTL when the owner set one; ownerOf reads them back", () => {
	assert.deepEqual([OWNER_LABEL, IDLE_TTL_LABEL], ["agentrun.owner", "agentrun.idle-ttl-ms"]);
	assert.deepEqual(ownerLabels({ agent: "ag-1" }), { "agentrun.owner": "agent:ag-1" });
	assert.deepEqual(ownerLabels({ agent: "ag-1", idleTtlMs: 3_600_000 }), { "agentrun.owner": "agent:ag-1", "agentrun.idle-ttl-ms": "3600000" });
	assert.deepEqual(ownerOf(ownerLabels({ agent: "ag-1", idleTtlMs: 60_000 })), { ok: true, value: { agent: "ag-1", idleTtlMs: 60_000 } });
	assert.deepEqual(ownerOf({ ...runLabels("r", 1) }), { ok: true, value: undefined }, "a run's computer has no owner");
	for (const [owner, words] of [
		[{ agent: "" }, /owner\.agent must be the agent's id/],
		[{ agent: "a\0b" }, /NUL/],
		[{ agent: "a", idleTtlMs: 0 }, /idleTtlMs is a whole number of milliseconds above 0/],
		[{ agent: "a", idleTtlMs: 1.5 }, /idleTtlMs/],
	]) {
		assert.throws(() => ownerLabels(owner), (error) => error instanceof TypeError && words.test(error.message), JSON.stringify(owner));
		assert.match(ownerProblem(owner), words);
	}
	for (const [labels, words] of [
		[{ [OWNER_LABEL]: "ag-1" }, /reads "ag-1", not agent:<id>/],
		[{ [OWNER_LABEL]: "agent:" }, /not agent:<id>/],
		[{ [OWNER_LABEL]: "agent:a", [IDLE_TTL_LABEL]: "01" }, /reads "01", not a whole number of milliseconds above 0/],
		[{ [OWNER_LABEL]: "agent:a", [IDLE_TTL_LABEL]: "0" }, /not a whole number of milliseconds above 0/],
	]) {
		const read = ownerOf(labels);
		assert.equal(read.ok, false, JSON.stringify(labels));
		assert.equal(read.error.code, "invalid");
		assert.match(read.error.message, words);
	}
});

test("checkTenure: a run's computer needs a lifetime; an agent's needs persistence, an owner that is one, and no lifetime", () => {
	const run = { lifetime: "janitor", maxLifetimeMs: 3_600_000 };
	const persists = { ...run, persistence: { keepsState: true, resume: false } };
	const fields = (refusals) => refusals.map((r) => r.field);
	assert.deepEqual(checkTenure({ lifetimeMs: 60_000 }, run), []);
	assert.deepEqual(fields(checkTenure({}, run)), ["lifetimeMs"], "a run's computer with no lifetime");
	assert.deepEqual(fields(checkTenure({}, persists)), ["lifetimeMs"], "a run's computer with no lifetime, on a provider that persists");
	const refused = checkTenure({ owner: { agent: "a" } }, run, "Docker");
	assert.deepEqual(fields(refused), ["owner"]);
	assert.match(refused[0].message, /^the Docker provider keeps no computer for an agent \(it declares no persistence\), so spec\.owner is refused/);
	assert.deepEqual(checkTenure({ owner: { agent: "a", idleTtlMs: 60_000 } }, persists), [], "an agent's computer with no lifetime");
	assert.deepEqual(fields(checkTenure({ owner: { agent: "a" }, lifetimeMs: 60_000 }, persists)), ["lifetimeMs"], "an agent's computer with a lifetime");
	assert.deepEqual(fields(checkTenure({ owner: { agent: "" } }, persists)), ["owner"], "an owner that is not one");
	assert.throws(() => runLifetimeMs({}), /a run's computer needs lifetimeMs/);
	assert.equal(runLifetimeMs({ lifetimeMs: 5 }), 5);
});

test("every provider refuses spec.owner in its check(), in words: none of them keeps a computer for an agent yet", () => {
	for (const [id, provider] of providers()) {
		const { lifetimeMs: _, ...base } = SPEC;
		const refusals = provider.check({ ...base, owner: { agent: "ag-1" } });
		assert.ok(refusals.some((r) => r.field === "owner" && /declares no persistence/.test(r.message)), `${id}: ${JSON.stringify(refusals)}`);
	}
});
