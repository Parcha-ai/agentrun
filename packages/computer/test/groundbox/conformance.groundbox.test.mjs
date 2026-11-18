// The conformance suite on real Groundbox, one test per case: only when both AGENTRUN_COMPUTER_LIVE_GROUNDBOX=1 and
// COMPUTER_GROUNDBOX_API_KEY are set. COMPUTER_GROUNDBOX_IMAGE names the image every computer starts from (a public
// image, a template, or "default" for Groundbox's own); unset, it is the box image prepareImage() answers. The key is read
// only past that first check, and never from GROUNDBOX_API_KEY, which may hold another team's key. Needs
// `npm run build` and `npm run build:daemon` (the daemon is uploaded into each sandbox), and Go on PATH for the drift
// case. The runner deletes every computer it made; the after hook deletes any computer left with this run's label.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";
import { conformanceImage, conformanceNotes, createDriftedProvider, createProvider } from "../../dist/conformance/groundbox.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_GROUNDBOX === "1" && Boolean(process.env.COMPUTER_GROUNDBOX_API_KEY);
const skip = LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_GROUNDBOX=1 and COMPUTER_GROUNDBOX_API_KEY (your own key, for a team you can bill) to run on real Groundbox";

describe("the conformance suite on Groundbox", { skip }, () => {
	let report;
	let run;
	let provider;
	const made = new Map();

	before(async () => {
		provider = await createProvider();
		const create = provider.create.bind(provider);
		provider.create = async (spec, context) => {
			run ??= spec.labels?.["agentrun.conformance"];
			const created = await create(spec, context);
			if (created.ok) made.set(created.value.id, created.value);
			return created;
		};
		// Release waits up to 120 s for Groundbox to read a deleted sandbox ended; cleanup gives it more.
		report = await runConformance(provider, { image: await conformanceImage(), cleanupTimeoutMs: 150_000, notes: conformanceNotes, drifted: () => createDriftedProvider() });
		console.log(formatReport(report));
	});

	after(async () => {
		const left = run ? await provider.list({ "agentrun.conformance": run }) : { ok: true, value: [] };
		for (const ref of new Map([...made, ...(left.ok ? left.value.map((info) => [info.ref.id, info.ref]) : [])]).values()) {
			await provider.release(ref, "delete");
		}
	});

	it("has cases in every group", () => {
		for (const group of ["health", "exec", "files", "process", "provider", "drift"]) {
			assert.ok(conformanceCases.some((c) => c.group === group), `no ${group} case`);
		}
	});

	for (const { id, level } of conformanceCases) {
		it(`${level} ${id}`, (t) => {
			const result = report.results.find((r) => r.id === id);
			assert.ok(result, `${id} did not run`);
			if (result.status === "skip") return t.skip(result.reason);
			assert.equal(result.status, "pass", result.reason);
		});
	}

	it("passes Core with computerd as a child, daemon and provider of one version", () => {
		assert.deepEqual([report.kind, report.daemonMode], ["linux", "child"]);
		assert.equal(report.core, "pass", formatReport(report));
		assert.ok(report.daemons.length > 0 && report.daemons.every((daemon) => daemon.version === report.providerVersion), JSON.stringify(report.daemons));
	});

	it("leaves no computer behind", async () => {
		assert.deepEqual(report.cleanup.left, []);
		assert.deepEqual(report.cleanup.errors, []);
		assert.ok(run, "the run labelled its computers");
		const listed = await provider.list({ "agentrun.conformance": run });
		assert.deepEqual(listed.ok ? listed.value.map((info) => info.ref.name) : listed.error, []);
	});
});
