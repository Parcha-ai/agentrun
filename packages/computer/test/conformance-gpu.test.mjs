// GPUs in the conformance suite, against fake computers: provider.check-refuses holds every provider to the GPU rule
// (one it does not declare is refused in words, by check() and create(); a provider with no gpu refuses any), and the
// Full case gpu.present, run only where gpu is declared and the run names the GPU it pays for, finds the GPUs in
// attach's read-back and in nvidia-smi as the computer's user. Also checkGpu, the rule every provider's check() shares.
import assert from "node:assert/strict";
import test from "node:test";
import { checkGpu, conformanceCases, runConformance } from "../dist/index.js";
import { fakeComputers } from "./fake-computer.mjs";

const IMAGE = "fixture:image";
const GPU = { types: ["T4", "A100-80GB"], max: 4 };
const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasonOf = (report, id) => report.results.find((r) => r.id === id)?.reason ?? "";
const run = (options, ids, extra = {}) => runConformance(fakeComputers(options).provider, { image: IMAGE, cases: conformanceCases.filter((c) => ids.includes(c.id)), ...extra });

test("checkGpu: no spec.gpu is no refusal; a provider with no gpu refuses any; a type it offers, and a whole count from 1 to max, alone pass", () => {
	assert.deepEqual(checkGpu(undefined, {}), []);
	assert.deepEqual(checkGpu(undefined, { gpu: GPU }), []);
	const field = (refusals) => refusals.map((r) => r.field);
	assert.deepEqual(field(checkGpu({ type: "T4", count: 1 }, {})), ["gpu"]);
	assert.match(checkGpu({ type: "T4", count: 1 }, {})[0].message, /offers no GPU/);
	for (const gpu of ["T4", 1, null, [], { count: 1 }, { type: "T4" }, { type: "V100", count: 1 }, { type: "T4", count: 0 }, { type: "T4", count: 5 }, { type: "T4", count: 1.5 }, { type: "T4", count: "1" }]) {
		assert.deepEqual(field(checkGpu(gpu, { gpu: GPU })), ["gpu"], `gpu ${JSON.stringify(gpu)}`);
	}
	assert.match(checkGpu({ type: "V100", count: 1 }, { gpu: GPU })[0].message, /not one this provider offers: T4, A100-80GB/);
	assert.match(checkGpu({ type: "T4", count: 5 }, { gpu: GPU })[0].message, /from 1 to 4/);
	assert.deepEqual(checkGpu({ type: "A100-80GB", count: 4 }, { gpu: GPU }), []);
	// gpu.mounts: the mount kinds a GPU computer takes, where the provider names fewer than its own.
	const unmounted = { ...GPU, mounts: [] };
	assert.deepEqual(field(checkGpu({ type: "T4", count: 1 }, { gpu: unmounted }, { kind: "archil" })), ["gpu"]);
	assert.match(checkGpu({ type: "T4", count: 1 }, { gpu: unmounted }, { kind: "archil" })[0].message, /takes no archil mount: it is not proven/);
	assert.deepEqual(checkGpu({ type: "T4", count: 1 }, { gpu: unmounted }), [], "no mount asked: none refused");
	assert.deepEqual(checkGpu({ type: "T4", count: 1 }, { gpu: { ...GPU, mounts: ["archil"] } }, { kind: "archil" }), []);
	assert.deepEqual(checkGpu({ type: "T4", count: 1 }, { gpu: GPU }, { kind: "archil" }), [], "no gpu.mounts: the provider's own mounts hold");
});

test("provider.check-refuses: a provider with no gpu refuses any spec.gpu; one that declares gpu refuses a type it does not offer and a count outside 1 to max", async () => {
	assert.equal(statuses(await run({}, ["provider.check-refuses"]))["provider.check-refuses"], "pass", "no gpu declared, any refused");
	assert.equal(statuses(await run({ gpu: GPU }, ["provider.check-refuses"]))["provider.check-refuses"], "pass", "gpu declared, the rest refused");
	for (const options of [{ checkIgnoresGpu: true }, { gpu: GPU, checkIgnoresGpu: true }]) {
		const report = await run(options, ["provider.check-refuses"]);
		assert.equal(statuses(report)["provider.check-refuses"], "fail", JSON.stringify(options));
		assert.match(reasonOf(report, "provider.check-refuses"), /check of gpu .* refuses gpu in words/);
	}
});

test("gpu.present is a Full case of its own group, run only where gpu is declared: skipped where it is not, and where the run names no GPU", async () => {
	const [found] = conformanceCases.filter((c) => c.id === "gpu.present");
	assert.equal(found.level, "full");
	assert.equal(found.group, "gpu");
	assert.deepEqual([...found.needs], ["gpu"], "exec is checked on its own computer: a need would make the run's shared one for it");
	const undeclared = await run({}, ["gpu.present"], { gpu: { type: "T4", count: 1 } });
	assert.equal(statuses(undeclared)["gpu.present"], "skip");
	assert.match(reasonOf(undeclared, "gpu.present"), /does not declare gpu/);
	const unnamed = await run({ gpu: GPU }, ["gpu.present"]);
	assert.equal(statuses(unnamed)["gpu.present"], "skip");
	assert.match(reasonOf(unnamed, "gpu.present"), /named no GPU: give --gpu/);
});

test("gpu.present passes where attach reads back the GPUs asked and nvidia-smi lists them as the computer's user; it fails where either does not", async () => {
	const asked = { type: "A100-80GB", count: 2 };
	const fakes = fakeComputers({ gpu: GPU });
	const passing = await runConformance(fakes.provider, { image: IMAGE, cases: conformanceCases.filter((c) => c.id === "gpu.present"), gpu: asked });
	assert.equal(statuses(passing)["gpu.present"], "pass", reasonOf(passing, "gpu.present"));
	assert.equal(fakes.made.length, 1, "one computer, the GPU one: no shared computer is made for the case alone");
	assert.ok(passing.results[0].observed.some((line) => line.includes("GPU 1: NVIDIA A100-80GB")), JSON.stringify(passing.results[0].observed));
	for (const [options, words] of [
		[{ gpu: GPU, gpuUnseen: true }, /nvidia-smi -L as the computer's user/],
		[{ gpu: GPU, gpuReadBack: { type: "T4", count: 2 } }, /the GPUs attach reads back/],
	]) {
		const report = await run(options, ["gpu.present"], { gpu: asked });
		assert.equal(statuses(report)["gpu.present"], "fail", JSON.stringify(options));
		assert.match(reasonOf(report, "gpu.present"), words);
	}
	const refused = await run({ gpu: GPU }, ["gpu.present"], { gpu: { type: "H100", count: 1 } });
	assert.equal(statuses(refused)["gpu.present"], "fail", "a GPU the provider does not offer fails the case's own check");
});
