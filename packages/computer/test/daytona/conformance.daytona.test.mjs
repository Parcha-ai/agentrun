// The conformance suite on real Daytona, one test per case: only when both AGENTRUN_COMPUTER_LIVE_DAYTONA=1 and
// COMPUTER_DAYTONA_API_KEY are set. COMPUTER_DAYTONA_SNAPSHOT names the snapshot every computer starts from; unset, it is
// "default", Daytona's default snapshot (the create sends no snapshot field). The module bounds every sandbox's life
// (autoStopMinutes 30, autoDeleteMinutes 0), so a stop deletes, and the provider declares it (stopDeletes): its note,
// printed with the report, says what provider.stop and provider.janitor do with that. The key is read only past that
// first check, and never from DAYTONA_API_KEY, which may hold another organization's key. Needs
// `npm run build` and `npm run build:daemon`, and Go on PATH for the drift case. The runner deletes every computer it
// made; the after hook deletes any computer left with this run's label.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";
import { conformanceImage, conformanceNotes, createDriftedProvider, createProvider } from "../../dist/conformance/daytona.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DAYTONA === "1" && Boolean(process.env.COMPUTER_DAYTONA_API_KEY);
const SNAPSHOT = LIVE ? conformanceImage() : undefined;
const skip = LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DAYTONA=1 and COMPUTER_DAYTONA_API_KEY (an OKed key) to run on real Daytona";

describe("the conformance suite on Daytona", { skip }, () => {
	let report;
	let run;
	let provider;
	const made = new Map();

	before(async () => {
		provider = createProvider();
		const create = provider.create.bind(provider);
		provider.create = async (spec, context) => {
			run ??= spec.labels?.["agentrun.conformance"];
			const created = await create(spec, context);
			if (created.ok) made.set(created.value.id, created.value);
			return created;
		};
		report = await runConformance(provider, { image: SNAPSHOT, cleanupTimeoutMs: 150_000, notes: conformanceNotes, drifted: () => createDriftedProvider() });
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

	it("passes Core, with daemon and provider of one version", () => {
		assert.equal(report.core, "pass", formatReport(report));
		assert.equal(report.daemon?.version, report.providerVersion);
	});

	it("leaves no computer behind", async () => {
		assert.deepEqual(report.cleanup.left, []);
		assert.deepEqual(report.cleanup.errors, []);
		assert.ok(run, "the run labelled its computers");
		const listed = await provider.list({ "agentrun.conformance": run });
		assert.deepEqual(listed.ok ? listed.value.map((info) => info.ref.name) : listed.error, []);
	});
});
