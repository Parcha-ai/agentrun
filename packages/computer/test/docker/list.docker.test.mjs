// list() and the janitor's sweep on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only), over a container that wears the
// computer label and a computer's name but was made by hand with no --mount, as `docker run --label agentrun.computer=1`
// makes one: Docker leaves HostConfig.Mounts out of its inspect, and list()'s --format template runs on the real docker
// CLI against it. A template that reads a key the inspect lacks fails the whole list (Docker runs it with
// missingkey=error), and with it every sweep of the host. Needs `npm run build` first, and debian:bookworm-slim pulled.
// The container carries a label with this test's own id and is removed by its exact name in the after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import { DockerProvider } from "../../dist/docker.js";
import { sweep } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const TEST_LABEL = "agentrun.test.run";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });

describe("list() and sweep() on a labelled container made with no --mount", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const test = randomBytes(6).toString("hex");
	const name = `computer-${randomBytes(6).toString("hex")}`;
	const ours = () => docker("ps", "-a", "--filter", `label=${TEST_LABEL}=${test}`, "--format", "{{.Names}}").split("\n").filter(Boolean);

	after(() => {
		if (ours().includes(name)) docker("rm", "-f", name);
	});

	it("lists it through the real docker CLI, then sweeps it past its deadline", async () => {
		docker("create", "--name", name, "--network", "none", "--label", "agentrun.computer=1", "--label", "agentrun.computer.deadline=2026-01-01T00:00:00.000Z", "--label", `${TEST_LABEL}=${test}`, "debian:bookworm-slim", "true");
		// list() makes no computer, so it needs no daemon binary.
		const provider = new DockerProvider({ daemonPath: "/nonexistent/computerd" });
		const listed = await provider.list({ [TEST_LABEL]: test });
		assert.equal(listed.ok, true, listed.ok ? "" : listed.error.message);
		assert.deepEqual(listed.value.map((info) => info.ref.name), [name]);
		assert.equal(listed.value[0].deadline?.toISOString(), "2026-01-01T00:00:00.000Z");
		const swept = await sweep(provider, { labels: { [TEST_LABEL]: test } });
		assert.equal(swept.ok, true, swept.ok ? "" : swept.error.message);
		assert.deepEqual(swept.value.deleted, [name]);
		assert.deepEqual(ours(), []);
	});
});
