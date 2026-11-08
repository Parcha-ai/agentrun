// The conformance suite on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only), one test per case, so a failure names its
// case. Needs `npm run build` and `npm run build:daemon` first, Go on PATH (the drift case builds a daemon of another
// version), and debian:bookworm-slim pulled. The runner removes every computer it made; the after hook removes any
// container with this run's label by its exact name, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { conformanceCases, formatReport, runConformance } from "../../dist/index.js";
import { createDriftedProvider, createProvider } from "../../dist/conformance/docker.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const labelled = (run) => docker("ps", "-a", "--filter", `label=agentrun.conformance=${run}`, "--format", "{{.Names}}").split("\n").filter(Boolean);

describe("the conformance suite on Docker", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	let report;
	let run;
	const made = new Set();

	before(async () => {
		const provider = await createProvider();
		const drifted = () => createDriftedProvider();
		const create = provider.create.bind(provider);
		provider.create = async (spec, context) => {
			run ??= spec.labels?.["agentrun.conformance"];
			const created = await create(spec, context);
			if (created.ok) made.add(created.value.name);
			return created;
		};
		report = await runConformance(provider, { image: IMAGE, drifted });
		console.log(formatReport(report));
	});

	after(() => {
		for (const name of new Set([...made, ...(run ? labelled(run) : [])])) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the runner.
			}
		}
	});

	it("has cases in every group", () => {
		for (const group of ["health", "exec", "files", "process", "provider", "drift", "screen", "input", "touch", "apps", "lifetime"]) {
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

	it("is a linux computer with computerd as PID 1, and skips each screen, input, touch, apps and lifetime case in words", () => {
		assert.deepEqual([report.kind, report.daemonMode], ["linux", "pid1"]);
		const extension = report.results.filter((r) => ["screen", "input", "touch", "apps", "lifetime"].includes(r.group));
		assert.ok(extension.length > 0, "the extension's cases ran");
		for (const r of extension) {
			assert.equal(r.status, "skip", `${r.id}: ${r.reason}`);
			assert.match(r.reason, /^the provider (does not declare|has no) /, r.id);
			assert.ok(r.undeclared?.length > 0, `${r.id} names what was not declared`);
		}
		const kind = report.results.find((r) => r.id === "health.kind-consistent");
		assert.equal(kind?.status, "pass", kind?.reason);
	});

	it("leaves no computer behind", () => {
		assert.deepEqual(report.cleanup.left, []);
		assert.deepEqual(report.cleanup.errors, []);
		assert.ok(run, "the run labelled its computers");
		assert.deepEqual(labelled(run), []);
	});
});
