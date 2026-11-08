// provider.release-older, the takeover case of the conformance suite, against the fake provider (test/fake-computer.mjs):
// it passes a provider that carries the run and epoch labels and lists and releases by them, and fails one whose list
// ignores the label filter, whose release fails, or whose release leaves the computer. No Docker, no daemon binary.
import assert from "node:assert/strict";
import test from "node:test";
import { conformanceCases, EPOCH_LABEL, runConformance } from "../dist/index.js";
import { fakeComputers } from "./fake-computer.mjs";

const IMAGE = "debian:bookworm-slim";
const ID = "provider.release-older";
const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasons = (report) => Object.fromEntries(report.results.filter((r) => r.reason).map((r) => [r.id, r.reason]));
const run = (options = {}) => {
	const fake = fakeComputers(options);
	return runConformance(fake.provider, { image: IMAGE, cases: conformanceCases.filter((c) => c.id === ID) }).then((report) => ({ report, fake }));
};

test("provider.release-older is one Full case of the provider group, on computers of its own", () => {
	const found = conformanceCases.filter((c) => c.id === ID);
	assert.deepEqual(
		found.map((c) => [c.level, c.group, c.needs, c.computer]),
		[["full", "provider", [], "none"]],
	);
});

test("provider.release-older passes a provider that carries the labels, lists by them and deletes, and leaves nothing", async () => {
	const { report, fake } = await run();
	assert.deepEqual(statuses(report), { [ID]: "pass" }, JSON.stringify(reasons(report)));
	assert.deepEqual(report.cleanup.left, []);
	assert.deepEqual(fake.alive(), []);
	// It made the run's three epochs and another run's epoch 1, each with both labels.
	const labelled = fake.made.filter(({ labels }) => labels["agentrun.run"] !== undefined).map(({ labels }) => labels[EPOCH_LABEL]);
	assert.deepEqual(labelled.sort(), ["1", "1", "2", "3"]);
	const runs = new Set(fake.made.map(({ labels }) => labels["agentrun.run"]).filter(Boolean));
	assert.equal(runs.size, 2, "two runs");
});

/** For each misbehaving fake: the options, and what the failure says. */
const BROKEN = [
	// releaseOlder re-checks the run label, so it releases the right ones; the case's own list by the run label shows the rest.
	["a list that ignores the label filter", { listIgnoresLabels: true }, /^the run's computers after releaseOlder at epoch 3: expected \["fake-\d+"\], got \[.*,.*\]$/],
	[
		"a release that fails",
		{ failRelease: { [EPOCH_LABEL]: "2" } },
		/^releaseOlder at epoch 3: refused: the release of run "conformance-[0-9a-f]+"'s computers below epoch 3 is incomplete: it released fake-\d+, and could not release fake-\d+ \(epoch 2\): the fake cannot delete fake-\d+$/,
	],
	["a release that answers ok and leaves the computer", { keepOnRelease: true }, /^attach to fake-\d+, released: expected an error \(not_found\), got ok /],
];

for (const [what, options, words] of BROKEN) {
	test(`provider.release-older fails ${what}`, async () => {
		const { report } = await run(options);
		assert.equal(statuses(report)[ID], "fail", reasons(report)[ID] ?? "passed");
		assert.match(reasons(report)[ID], words);
	});
}
