// What only Docker shows of a computer's processes, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): docker stop
// with a process running that ignores TERM, and the daemon as PID 1 still exits 0, not 137. What every provider must
// do with processes is in the conformance suite (conformance.docker.test.mjs). Needs `npm run build` and
// `npm run build:daemon` first, and debian:bookworm-slim pulled. Every container this file makes is removed by its exact
// name in the after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });

describe("stop a Docker computer with a process running", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	let provider;

	before(() => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
	});

	after(() => {
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the test.
			}
		}
	});

	it("the daemon as PID 1 exits 0, not 137, though a process ignores TERM", async () => {
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", labels: { "agentrun.test": "processes" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		const ref = created.value;
		made.push(ref.name);
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		const started = await connected.value.client.call("process.start", { argv: ["sh", "-c", "trap '' TERM; sleep 600"] });
		assert.equal(started.ok, true, JSON.stringify(started));
		await connected.value.close();
		assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		assert.equal(inspected.State.Running, false);
		assert.equal(inspected.State.ExitCode, 0);
	});
});
