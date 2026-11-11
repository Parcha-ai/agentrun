// A create aborted while its `docker run` is under way, against the fake docker in test/fake-docker.mjs: the abort kills
// the CLI client, but the Docker daemon still makes the container a moment later. create removes it all the same, the
// egress proxy's run and the computer's own, so nothing is left Created for the janitor to find later.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { settleWords } from "../dist/docker.js";
import { fakeDocker } from "./fake-docker.mjs";

const ALLOW = ["pypi.org"];
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };

/** create(spec) on `fake` (made with lateRun), aborted once the daemon's late create has begun: the fake's daemon
 *  process marks it before the CLI can be cut off, so the abort always lands with a create under way. */
async function abortedLate(fake, spec) {
	const controller = new AbortController();
	const watch = (async () => {
		while (!controller.signal.aborted) {
			if (fake.late().started) return controller.abort();
			await sleep(10);
		}
	})();
	const made = await fake.provider.create(spec, { signal: controller.signal });
	await watch;
	return made;
}

test("an abort during the egress proxy's docker run, which the daemon still finishes after the CLI is gone, leaves no proxy and no volume", { timeout: 30_000 }, async () => {
	const fake = fakeDocker({ lateRun: "egress" });
	const made = await abortedLate(fake, { ...SPEC, network: { allow: ALLOW } });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "aborted");
	assert.match(made.error.message, /^create was aborted during docker run of the egress proxy; the proxy and its volume, if Docker made them after, were removed; the computer computer-[0-9a-f]{12} was never run, and its proxy and volume were removed$/);
	// The daemon did make the proxy after the CLI was killed, and it, with the volume made before it, is gone, and stays gone.
	assert.match(fake.late().committed ?? "", /^computer-[0-9a-f]{12}-egress$/, "the late create happened");
	await sleep(500);
	assert.deepEqual(fake.names(), []);
	assert.deepEqual(fake.volumeNames(), []);
	// It was removed with its anonymous volumes, as release removes a computer.
	assert.ok(fake.calls().some((args) => args.join(" ") === `rm --force --volumes ${fake.late().committed}`));
});

test("an abort during the computer's own docker run, which the daemon still finishes, leaves no computer, and with an allowlist no proxy or volume", { timeout: 60_000 }, async () => {
	for (const network of ["none", { allow: ALLOW }]) {
		const fake = fakeDocker({ lateRun: "computer" });
		const made = await abortedLate(fake, { ...SPEC, network });
		assert.equal(made.ok, false);
		assert.equal(made.error.code, "aborted");
		const what = network === "none" ? "the computer computer-[0-9a-f]{12} was removed, if Docker made it after" : "the computer computer-[0-9a-f]{12}, its proxy and its volume were removed, if Docker made them after";
		assert.match(made.error.message, new RegExp(`^create was aborted during docker run; ${what}$`));
		assert.match(fake.late().committed ?? "", /^computer-[0-9a-f]{12}$/, "the late create happened");
		await sleep(500);
		assert.deepEqual(fake.names(), [], JSON.stringify(network));
		assert.deepEqual(fake.volumeNames(), [], JSON.stringify(network));
	}
});

test("a late container that Docker will not remove is named in the error once the 10 s bound is spent", { timeout: 60_000 }, async () => {
	// The proxy the daemon makes after the abort is one rm never removes: the bound runs out with it still there.
	const fake = fakeDocker({ lateRun: "egress", sticky: ["-egress"] });
	const made = await abortedLate(fake, { ...SPEC, network: { allow: ALLOW } });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "aborted");
	const proxy = fake.late().committed;
	assert.match(proxy ?? "", /^computer-[0-9a-f]{12}-egress$/);
	assert.ok(
		made.error.message.startsWith(`create was aborted during docker run of the egress proxy; the proxy and its volume could not all be removed: the container ${proxy} was still there 10 s after docker run was cut off; `),
		made.error.message,
	);
});

test("settleWords always names what it checked: what the last look still found, or, after a last look that found none before the quiet window was complete, every name, as not confirmed gone", () => {
	const container = "the container computer-0123456789ab-egress";
	const volume = "the volume computer-0123456789ab-egress";
	assert.equal(settleWords([container, volume], [container]), `${container} was still there 10 s after docker run was cut off`);
	assert.equal(settleWords([container, volume], [container, volume]), `${container} and ${volume} were still there 10 s after docker run was cut off`);
	// The bound ran out right after a look that found none: never an empty subject.
	assert.equal(settleWords([container, volume], []), `${container} and ${volume} could not be confirmed gone within 10 s after docker run was cut off: the last look found none, but not for 3 s in a row`);
	assert.equal(settleWords([], []), "what docker run may have made could not be confirmed gone within 10 s after docker run was cut off: the last look found none, but not for 3 s in a row");
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
