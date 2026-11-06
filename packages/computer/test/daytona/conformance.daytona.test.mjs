// The conformance suite on real Daytona, one test per case: only when both AGENTRUN_COMPUTER_LIVE_DAYTONA=1 and
// DAYTONA_API_KEY are set, and AGENTRUN_DAYTONA_SNAPSHOT names the snapshot every computer starts from. The key is read
// only past that first check. Needs `npm run build` and `npm run build:daemon`, and Go on PATH for the drift case. The
// runner deletes every computer it made; the after hook deletes any computer left with this run's label.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";
import { createDriftedProvider, createProvider } from "../../dist/conformance/daytona.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DAYTONA === "1" && Boolean(process.env.DAYTONA_API_KEY);
const SNAPSHOT = LIVE ? process.env.AGENTRUN_DAYTONA_SNAPSHOT : undefined;
const skip = !LIVE
	? "set AGENTRUN_COMPUTER_LIVE_DAYTONA=1 and DAYTONA_API_KEY (an OKed key) to run on real Daytona"
	: SNAPSHOT
		? false
		: "set AGENTRUN_DAYTONA_SNAPSHOT to the Daytona snapshot every computer starts from";

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
		report = await runConformance(provider, { image: SNAPSHOT, drifted: () => createDriftedProvider() });
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
