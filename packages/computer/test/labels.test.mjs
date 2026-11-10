// The run and epoch labels (src/labels.ts): the two names in one place, the run id rule, and a computer's epoch read from
// its labels; and no provider refuses them. No Docker, no vendor: each provider's check() runs on its fake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DaytonaProvider } from "../dist/daytona.js";
import { EPOCH_LABEL, epochOf, epochProblem, RUN_LABEL, runLabels, runProblem } from "../dist/index.js";
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
