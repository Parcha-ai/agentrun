// The conformance suite on a real Kubernetes cluster, one test per case: only when AGENTRUN_COMPUTER_LIVE_KUBERNETES=1
// and the module's settings are set (COMPUTER_KUBERNETES_KUBECONFIG, a JSON kubeconfig file, or COMPUTER_KUBERNETES_API_URL
// with its auth), with COMPUTER_KUBERNETES_IMAGE (pod) or COMPUTER_KUBERNETES_WARM_POOL (claim). A local kind cluster
// does: see the README's Kubernetes section. Never KUBECONFIG, which may point at a shared cluster. Needs `npm run build`
// and `npm run build:daemon`, and Go on PATH for the drift case. The runner deletes every computer it made; the after
// hook deletes any computer left with this run's label.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";
import { conformanceImage, conformanceNotes, createDriftedProvider, createProvider } from "../../dist/conformance/kubernetes.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_KUBERNETES === "1" && Boolean(process.env.COMPUTER_KUBERNETES_KUBECONFIG || process.env.COMPUTER_KUBERNETES_API_URL);
const skip = LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_KUBERNETES=1 and COMPUTER_KUBERNETES_KUBECONFIG (a JSON kubeconfig of a cluster you may make pods in) to run on a real cluster";

describe("the conformance suite on Kubernetes", { skip }, () => {
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
		report = await runConformance(provider, { image: conformanceImage(), cleanupTimeoutMs: 150_000, notes: conformanceNotes, drifted: () => createDriftedProvider() });
		console.log(formatReport(report));
	});

	after(async () => {
		const left = run ? await provider.list({ "agentrun.conformance": run }) : { ok: true, value: [] };
		for (const ref of new Map([...made, ...(left.ok ? left.value.map((info) => [info.ref.id, info.ref]) : [])]).values()) {
			await provider.release(ref, "delete");
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
