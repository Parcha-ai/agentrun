// The run and epoch labels on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only), with no Docker code of their own: a
// computer made with runLabels(run, epoch) carries agentrun.run and agentrun.epoch as container labels, list() finds it
// by the run's label, and releaseOlder deletes the run's lower epochs and the one with no epoch, keeps this epoch's and
// another run's, and is refused as fenced once a higher epoch holds the run. Needs `npm run build` and
// `npm run build:daemon` first, and alpine:3.20 pulled. Every computer this file makes carries a label with this test's
// own id and is removed by its exact name in the after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider } from "../../dist/docker.js";
import { EPOCH_LABEL, RUN_LABEL, releaseOlder, runLabels } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const TEST_LABEL = "agentrun.test.run";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const names = (refs) => refs.map((ref) => ref.name).sort();

describe("run and epoch labels on Docker", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const test = randomBytes(6).toString("hex");
	const run = `run-${test}`;
	const other = `other-${test}`;
	const refs = {};
	let provider;

	/** Names of this test's containers that carry these labels too, as docker ps itself filters them. */
	const ours = (labels = {}) =>
		docker("ps", "-a", "--filter", `label=${TEST_LABEL}=${test}`, ...Object.entries(labels).flatMap(([k, v]) => ["--filter", `label=${k}=${v}`]), "--format", "{{.Names}}")
			.split("\n")
			.filter(Boolean)
			.sort();

	before(async () => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
		const make = async (key, labels) => {
			const created = await provider.create({ image: "alpine:3.20", lifetimeMs: 10 * 60_000, network: "none", labels: { ...labels, [TEST_LABEL]: test, key } });
			assert.equal(created.ok, true, `${key}: ${JSON.stringify(created)}`);
			refs[key] = created.value;
		};
		await Promise.all([
			make("e1", runLabels(run, 1)),
			make("e2", runLabels(run, 2)),
			make("e3", runLabels(run, 3)),
			make("none", { [RUN_LABEL]: run }),
			make("other", runLabels(other, 1)),
		]);
	});

	after(() => {
		for (const name of new Set([...Object.values(refs).map((ref) => ref.name), ...ours()])) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the test.
			}
		}
	});

	it("carries agentrun.run and agentrun.epoch as container labels, and list() finds the run's computers by its label", async () => {
		const labels = JSON.parse(docker("inspect", "--format", "{{json .Config.Labels}}", refs.e3.name));
		assert.equal(labels[RUN_LABEL], run);
		assert.equal(labels[EPOCH_LABEL], "3");
		assert.equal(labels["agentrun.computer"], "1", "the provider's own label beside them");
		const listed = await provider.list({ [RUN_LABEL]: run });
		assert.equal(listed.ok, true, JSON.stringify(listed));
		assert.deepEqual(names(listed.value.map((info) => info.ref)), names([refs.e1, refs.e2, refs.e3, refs.none]));
		assert.deepEqual(Object.fromEntries(listed.value.map((info) => [info.ref.name, info.labels[EPOCH_LABEL]])), {
			[refs.e1.name]: "1",
			[refs.e2.name]: "2",
			[refs.e3.name]: "3",
			[refs.none.name]: undefined,
		});
	});

	it("releaseOlder at epoch 3 deletes epochs 1 and 2 and the computer with no epoch, and keeps epoch 3 and the other run's", async () => {
		const result = await releaseOlder(provider, run, 3);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(names(result.value.released), names([refs.e1, refs.e2, refs.none]));
		assert.deepEqual(result.value.kept, [refs.e3]);
		assert.deepEqual(result.value.unproven, [{ ref: refs.none, problem: `the computer carries no ${EPOCH_LABEL} label` }]);
		assert.deepEqual(ours({ [RUN_LABEL]: run }), [refs.e3.name], "the run's containers, as docker ps lists them");
		assert.deepEqual(ours({ [RUN_LABEL]: other }), [refs.other.name], "the other run's containers");
	});

	it("releaseOlder at epoch 2, with epoch 3 there, is refused as fenced and deletes nothing", async () => {
		const result = await releaseOlder(provider, run, 2);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "refused");
		assert.equal(result.error.message, `fenced: run "${run}" has ${refs.e3.name} at epoch 3, above this claim's epoch 2; a later claim holds the run, so nothing was released`);
		assert.deepEqual(ours(), names([refs.e3, refs.other]));
	});

	it("releaseOlder of the other run at its own epoch releases nothing; at epoch 4 it takes the run over", async () => {
		assert.deepEqual(await releaseOlder(provider, other, 1), { ok: true, value: { released: [], detached: [], kept: [refs.other], unproven: [] } });
		const taken = await releaseOlder(provider, run, 4);
		assert.deepEqual(taken, { ok: true, value: { released: [refs.e3], detached: [], kept: [], unproven: [] } });
		assert.deepEqual(ours(), [refs.other.name]);
	});
});
