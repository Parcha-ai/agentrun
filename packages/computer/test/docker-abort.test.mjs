// A create aborted while its `docker run` is under way, against the fake docker in test/fake-docker.mjs: the abort kills
// the CLI client, but the Docker daemon still makes the container a moment later. create removes it all the same, the
// egress proxy's run and the computer's own, so nothing is left Created for the janitor to find later.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeDocker } from "./fake-docker.mjs";

const ALLOW = ["pypi.org"];
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };

/** create(spec) on `fake`, aborted as soon as the `docker run` that `which` picks has started. */
async function abortedAt(fake, spec, which) {
	const controller = new AbortController();
	const watch = (async () => {
		while (!controller.signal.aborted) {
			if (fake.calls().some(which)) return controller.abort();
			await sleep(10);
		}
	})();
	const made = await fake.provider.create(spec, { signal: controller.signal });
	await watch;
	return made;
}

const runOf = (entrypoint) => (args) => args[0] === "run" && args[args.indexOf("--entrypoint") + 1] === entrypoint;

test("an abort during the egress proxy's docker run, which the daemon still finishes after the CLI is gone, leaves no proxy and no volume", { timeout: 30_000 }, async () => {
	const fake = fakeDocker({ lateRun: "egress" });
	const made = await abortedAt(fake, { ...SPEC, network: { allow: ALLOW } }, runOf("node"));
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "aborted");
	assert.match(made.error.message, /^create was aborted during docker run of the egress proxy; the proxy and its volume, if Docker made them after, were removed; the computer computer-[0-9a-f]{12} was never run, and its proxy and volume were removed$/);
	// The proxy the daemon made after the CLI was killed, and the volume made before it: both gone, and they stay gone.
	await sleep(500);
	assert.deepEqual(fake.names(), []);
	assert.deepEqual(fake.volumeNames(), []);
	assert.ok(fake.calls().filter((args) => args[0] === "inspect").length >= 2, "it looked again after its removal");
});

test("an abort during the computer's own docker run, which the daemon still finishes, leaves no computer, and with an allowlist no proxy or volume", { timeout: 30_000 }, async () => {
	for (const network of ["none", { allow: ALLOW }]) {
		const fake = fakeDocker({ lateRun: "computer" });
		const made = await abortedAt(fake, { ...SPEC, network }, runOf("/opt/agentrun/computerd"));
		assert.equal(made.ok, false);
		assert.equal(made.error.code, "aborted");
		const what = network === "none" ? "the computer computer-[0-9a-f]{12} was removed, if Docker made it after" : "the computer computer-[0-9a-f]{12}, its proxy and its volume were removed, if Docker made them after";
		assert.match(made.error.message, new RegExp(`^create was aborted during docker run; ${what}$`));
		await sleep(500);
		assert.deepEqual(fake.names(), [], JSON.stringify(network));
		assert.deepEqual(fake.volumeNames(), [], JSON.stringify(network));
	}
});

test("a docker run that ended with an exit of its own is cleaned up as before, once, with no settling", async () => {
	// The proxy's run answered, and the proxy then ended before it was ready: removed by release, as before.
	const egress = fakeDocker({ egress: "exits" });
	const made = await egress.provider.create({ ...SPEC, network: { allow: ALLOW } });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "docker");
	assert.match(made.error.message, /ended \(exit code 2\) before it was ready/);
	assert.deepEqual([egress.names(), egress.volumeNames()], [[], []]);
	assert.ok(!egress.calls().some((args) => args[0] === "volume" && args[1] === "inspect"), "no settle loop");
});
