// The conformance suite on real Modal, one test per case. It is skipped unless AGENTRUN_COMPUTER_LIVE_MODAL=1 and both
// COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET are in the environment: a key the lead has OKed by name, never
// set by a test or a script. MODAL_TOKEN_ID and MODAL_TOKEN_SECRET never count: a host may hold a production token under
// those names. It also needs COMPUTER_MODAL_APP, COMPUTER_MODAL_DAEMON_IMAGE (this version's daemon for linux/amd64,
// pinned by digest), the modal package installed where Node finds it, and `npm run build`. The runner deletes every
// computer it made; the after hook terminates any sandbox still made by this run, pass or fail.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";

/** Presence only: no token value is read here. The live switch is checked first, so without it nothing else is. */
const LIVE =
	process.env.AGENTRUN_COMPUTER_LIVE_MODAL === "1" && "COMPUTER_MODAL_TOKEN_ID" in process.env && "COMPUTER_MODAL_TOKEN_SECRET" in process.env;
const IMAGE = "debian:bookworm-slim";

describe(
	"the conformance suite on Modal (VM runtime)",
	{ skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_MODAL=1 with COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET (a key the lead OKed) to run on real Modal" },
	() => {
		let report;
		let provider;
		const made = new Map();

		before(async () => {
			const { createProvider, createDriftedProvider } = await import("../../dist/conformance/modal.js");
			provider = await createProvider();
			const create = provider.create.bind(provider);
			provider.create = async (spec, context) => {
				const created = await create(spec, context);
				if (created.ok) made.set(created.value.id, created.value);
				return created;
			};
			report = await runConformance(provider, { image: IMAGE, drifted: createDriftedProvider });
			console.log(formatReport(report));
		});

		after(async () => {
			for (const ref of made.values()) await provider?.release(ref, "delete");
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

		it("leaves no computer behind", () => {
			assert.deepEqual(report.cleanup.left, []);
			assert.deepEqual(report.cleanup.errors, []);
		});
	},
);
