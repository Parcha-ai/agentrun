// releaseOlder (src/janitor.ts), the takeover's first step, against the fake provider (test/fake-computer.mjs): a new
// claim releases every computer of the run with a lower epoch, or none it cannot prove current, and is refused as fenced
// when a higher epoch holds the run. No Docker, no daemon.
import assert from "node:assert/strict";
import test from "node:test";
import { EPOCH_LABEL, RUN_LABEL, releaseOlder, runLabels } from "../dist/index.js";
import { fakeComputers } from "./fake-computer.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const names = (refs) => refs.map((ref) => ref.name).sort();

/** A fake with one computer per entry ([run, epoch], or [run, labels] for a raw label set), and their refs by key. */
async function setup(entries, options = {}) {
	const fake = fakeComputers(options);
	const refs = {};
	for (const [key, run, epoch] of entries) {
		const labels = typeof epoch === "number" ? runLabels(run, epoch) : { [RUN_LABEL]: run, ...epoch };
		const made = await fake.provider.create({ ...SPEC, labels: { ...labels, key } });
		assert.equal(made.ok, true, JSON.stringify(made));
		refs[key] = made.value;
	}
	const released = () => fake.calls.filter(([what]) => what === "release").map(([, name]) => name);
	return { ...fake, refs, released };
}

test("releaseOlder deletes the run's computers with a lower epoch, keeps those of this epoch, and touches no other run", async () => {
	const { provider, refs, released, alive, calls } = await setup([
		["a1", "a", 1],
		["a2", "a", 2],
		["a3", "a", 3],
		["a3b", "a", 3],
		["b1", "b", 1],
		["b9", "b", 9],
	]);
	const result = await releaseOlder(provider, "a", 3);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(names(result.value.released), names([refs.a1, refs.a2]));
	assert.deepEqual(names(result.value.kept), names([refs.a3, refs.a3b]));
	assert.deepEqual(result.value.unproven, []);
	assert.deepEqual(released().sort(), names([refs.a1, refs.a2]));
	assert.ok(calls.filter(([what]) => what === "release").every(([, , how]) => how === "delete"), "every release is a delete");
	assert.deepEqual(alive().sort(), names([refs.a3, refs.a3b, refs.b1, refs.b9]));
	assert.deepEqual(calls[0], ["list", { [RUN_LABEL]: "a" }], "it lists by the run's label alone");
});

test("releaseOlder passes its signal to list", async () => {
	const { provider } = await setup([["a1", "a", 1]]);
	const list = provider.list;
	const seen = [];
	provider.list = async (labels, context) => {
		seen.push(context?.signal);
		return list(labels, context);
	};
	const signal = new AbortController().signal;
	assert.equal((await releaseOlder(provider, "a", 2, { signal })).ok, true);
	assert.deepEqual(seen, [signal]);
});

test("releaseOlder of a run with no computers, or only this epoch's, releases nothing", async () => {
	const { provider, refs, released } = await setup([["a2", "a", 2]]);
	assert.deepEqual(await releaseOlder(provider, "none", 5), { ok: true, value: { released: [], kept: [], unproven: [] } });
	assert.deepEqual(await releaseOlder(provider, "a", 2), { ok: true, value: { released: [], kept: [refs.a2], unproven: [] } });
	assert.deepEqual(released(), []);
});

test("a computer of the run with no epoch label, or one that is not an epoch, is released and named: it cannot prove it is current", async () => {
	const { provider, refs, alive } = await setup([
		["none", "a", {}],
		["padded", "a", { [EPOCH_LABEL]: "03" }],
		["signed", "a", { [EPOCH_LABEL]: "+3" }],
		["a3", "a", 3],
	]);
	const result = await releaseOlder(provider, "a", 3);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(names(result.value.released), names([refs.none, refs.padded, refs.signed]));
	assert.deepEqual(result.value.kept, [refs.a3]);
	assert.deepEqual(
		result.value.unproven.map(({ ref, problem }) => [ref.name, problem]),
		[
			[refs.none.name, `the computer carries no ${EPOCH_LABEL} label`],
			[refs.padded.name, `the label ${EPOCH_LABEL} reads "03", not an epoch: a decimal whole number with no sign, leading zero or space`],
			[refs.signed.name, `the label ${EPOCH_LABEL} reads "+3", not an epoch: a decimal whole number with no sign, leading zero or space`],
		],
	);
	assert.deepEqual(alive(), [refs.a3.name]);
});

test("a computer of the run with a higher epoch fences the claim: refused in words, and nothing is released", async () => {
	const { provider, refs, released, alive } = await setup([
		["a1", "a", 1],
		["none", "a", {}],
		["a2", "a", 2],
		["a4", "a", 4],
	]);
	const result = await releaseOlder(provider, "a", 2);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	assert.equal(result.error.message, `fenced: run "a" has ${refs.a4.name} at epoch 4, above this claim's epoch 2; a later claim holds the run, so nothing was released`);
	assert.deepEqual(released(), [], "not even the lower epoch was released");
	assert.equal(alive().length, 4);
});

test("releaseOlder re-checks each computer's run label: a list that ignores the filter cannot make it touch another run", async () => {
	const { provider, refs, released, alive } = await setup(
		[
			["a1", "a", 1],
			["a3", "a", 3],
			["b1", "b", 1],
			["b7", "b", 7],
			["nolabel", "c", {}],
		],
		{ listIgnoresLabels: true },
	);
	// The fake's list gives every computer, the other runs' too; b7's higher epoch fences nothing and b1 is not released.
	const result = await releaseOlder(provider, "a", 3);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.value.released, [refs.a1]);
	assert.deepEqual(result.value.kept, [refs.a3]);
	assert.deepEqual(released(), [refs.a1.name]);
	assert.deepEqual(alive().sort(), names([refs.a3, refs.b1, refs.b7, refs.nolabel]));
});

test("a computer listed with no run label at all is another run's: never released", async () => {
	const fake = fakeComputers({ listIgnoresLabels: true });
	const stray = await fake.provider.create({ ...SPEC, labels: { [EPOCH_LABEL]: "1" } });
	const result = await releaseOlder(fake.provider, "a", 3);
	assert.deepEqual(result, { ok: true, value: { released: [], kept: [], unproven: [] } });
	assert.deepEqual(fake.alive(), [stray.value.name]);
});

test("a release that fails: every release is still attempted, and the result is a failure naming each computer left and why", async () => {
	const { provider, refs, released, alive } = await setup(
		[
			["a1", "a", 1],
			["a2", "a", 2],
			["none", "a", { key: "x" }],
			["a3", "a", 3],
		],
		{ failRelease: { [EPOCH_LABEL]: "1" } },
	);
	const broken = provider.release;
	provider.release = async (ref, how) => (ref.name === refs.none.name ? { ok: false, error: { code: "timeout", message: `no answer for ${ref.name}` } } : broken(ref, how));
	const result = await releaseOlder(provider, "a", 3);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused", "the first failure's code");
	assert.equal(
		result.error.message,
		`the release of run "a"'s computers below epoch 3 is incomplete: it released ${refs.a2.name}, and could not release ` +
			`${refs.a1.name} (epoch 1): the fake cannot delete ${refs.a1.name}; ${refs.none.name} (no epoch): no answer for ${refs.none.name}`,
	);
	assert.deepEqual(released().sort(), names([refs.a1, refs.a2]), "the fake saw a1 and a2; the wrapper answered for the third");
	assert.deepEqual(alive().sort(), names([refs.a1, refs.none, refs.a3]));
});

test("releaseOlder gives list's failure in words, and releases nothing", async () => {
	const { provider, released } = await setup([["a1", "a", 1]]);
	provider.list = async () => ({ ok: false, error: { code: "vendor", vendor: "docker", message: "the docker CLI (docker) was not found" } });
	const result = await releaseOlder(provider, "a", 2);
	assert.deepEqual(result, { ok: false, error: { code: "vendor", vendor: "docker", message: `could not list run "a"'s computers: the docker CLI (docker) was not found` } });
	assert.deepEqual(released(), []);
});

test("an aborted releaseOlder starts no new release, and says which ran", async () => {
	const before = await setup([["a1", "a", 1]]);
	const early = await releaseOlder(before.provider, "a", 2, { signal: AbortSignal.abort() });
	assert.deepEqual(early, { ok: false, error: { code: "aborted", message: `the release of run "a"'s computers below epoch 2 was aborted before it began` } });
	assert.deepEqual(before.calls, [], "no list, no release");

	const { provider, refs, released } = await setup([
		["a1", "a", 1],
		["a2", "a", 2],
		["none", "a", {}],
		["a5", "a", 5],
	]);
	const controller = new AbortController();
	const release = provider.release;
	provider.release = async (ref, how) => {
		const done = await release(ref, how);
		controller.abort();
		return done;
	};
	const midway = await releaseOlder(provider, "a", 5, { signal: controller.signal });
	assert.equal(midway.ok, false);
	assert.equal(midway.error.code, "aborted");
	assert.equal(midway.error.message, `the release of run "a"'s computers below epoch 5 was aborted: it released ${refs.a1.name}; it did not start ${refs.a2.name}, ${refs.none.name}`);
	assert.deepEqual(released(), [refs.a1.name]);
});

test("an abort after a failed release still names the failure", async () => {
	const { provider, refs } = await setup(
		[
			["a1", "a", 1],
			["a2", "a", 2],
		],
		{ failRelease: { [EPOCH_LABEL]: "1" } },
	);
	const controller = new AbortController();
	const release = provider.release;
	provider.release = async (ref, how) => {
		const done = await release(ref, how);
		controller.abort();
		return done;
	};
	const result = await releaseOlder(provider, "a", 3, { signal: controller.signal });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "aborted");
	assert.equal(
		result.error.message,
		`the release of run "a"'s computers below epoch 3 was aborted: it released none, and could not release ${refs.a1.name} (epoch 1): the fake cannot delete ${refs.a1.name}; it did not start ${refs.a2.name}`,
	);
});

test("releaseOlder refuses a run or an epoch that is not one, with no call", async () => {
	const { provider, calls } = await setup([["a1", "a", 1]]);
	for (const [run, epoch, words] of [
		["", 1, /run id must be a non-empty string/],
		["a\0b", 1, /NUL/],
		[undefined, 1, /run id must be a non-empty string/],
		["a", -1, /epoch must be a whole number from 0/],
		["a", 1.5, /epoch must be a whole number from 0/],
		["a", "2", /epoch must be a whole number from 0/],
	]) {
		const result = await releaseOlder(provider, run, epoch);
		assert.equal(result.ok, false, JSON.stringify([run, epoch]));
		assert.equal(result.error.code, "invalid");
		assert.match(result.error.message, words);
	}
	assert.deepEqual(calls, []);
});
