// DockerProvider's volume option against the fake docker in test/fake-docker.mjs: a provider in a container of the
// Docker it drives (compose), whose files are on a named volume it has mounted at a root, mounts the daemon's copy and the
// run's folder as that volume's subpaths, never binds of its own paths, which the Docker daemon does not have.
import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import { DockerProvider, VOLUME_SUBPATH_ENGINE } from "../dist/index.js";
import { COPY_NAME, fakeDocker, valuesOf } from "./fake-docker.mjs";

const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const NAME = "agentrun_agentrun-data";
const runOf = (all) => all.find((args) => args[0] === "run");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "computer-docker-volume-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
let roots = 0;

/** A volume's root as the server's container has it, with the provider's daemon cache and one run's folder below it. */
function layout() {
	const root = join(scratch, `data-${++roots}`);
	const work = join(root, "disk", "agents", "a1", "runs", "r1", "work");
	mkdirSync(work, { recursive: true });
	if (process.getuid() === 0) chownSync(work, 1000, 1000);
	chmodSync(work, 0o700);
	return { root, work, daemonCache: join(root, "cache"), volume: { name: NAME, root } };
}

/** The fake docker with the volume option over `layout`'s root, the volume's files there. */
const withVolume = ({ root, daemonCache, volume }, more = {}) => fakeDocker({ daemonCache, volume, volumeRoots: { [NAME]: root }, ...more });

test("compose: create mounts the daemon's copy and the run's folder as the volume's subpaths, never a bind of this process's paths", async () => {
	const paths = layout();
	const { provider, calls } = withVolume(paths);
	const made = await provider.create({ ...SPEC, mount: { kind: "bind", path: paths.work } });
	assert.equal(made.ok, true, JSON.stringify(made));
	const mounts = valuesOf(runOf(calls()), "--mount");
	assert.deepEqual(mounts, [
		`type=volume,src=${NAME},dst=/opt/agentrun/computerd,volume-subpath=cache/${COPY_NAME},volume-nocopy,readonly`,
		`type=volume,src=${NAME},dst=/workspace,volume-subpath=disk/agents/a1/runs/r1/work,volume-nocopy`,
	]);
	assert.ok(!calls().some((args) => args.some((arg) => typeof arg === "string" && arg.startsWith("type=bind"))), "no bind of a path only this process's container has");
	// The drift check at create passed, and the read-back is the run's folder as create was given it.
	const attached = await provider.attach({ id: made.value.name });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec.mount, { kind: "bind", path: paths.work });
	const listed = await provider.list({});
	assert.deepEqual(listed.ok && listed.value.map((info) => info.mount), [{ kind: "bind", path: paths.work }]);
});

test("compose: a computer with no run folder mounts only the daemon's copy from the volume", async () => {
	const paths = layout();
	const { provider, calls } = withVolume(paths);
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	assert.deepEqual(valuesOf(runOf(calls()), "--mount"), [`type=volume,src=${NAME},dst=/opt/agentrun/computerd,volume-subpath=cache/${COPY_NAME},volume-nocopy,readonly`]);
	assert.equal((await provider.attach({ id: made.value.name })).ok, true);
});

test("compose: a run folder that is not below the volume's root, or is the root itself, is refused in words by check and create, before any docker run", async () => {
	const paths = layout();
	const outside = join(scratch, `elsewhere-${roots}`);
	mkdirSync(outside);
	chmodSync(outside, 0o700);
	for (const path of [outside, paths.root]) {
		const { provider, calls } = withVolume(paths);
		const refusals = provider.check({ ...SPEC, mount: { kind: "bind", path } });
		assert.equal(refusals.length, 1, JSON.stringify(refusals));
		assert.equal(refusals[0].field, "mount");
		assert.match(refusals[0].message, new RegExp(`mount\\.path ${path} is not below the provider's volume root ${paths.root} \\(the volume ${NAME}\\)`));
		const made = await provider.create({ ...SPEC, mount: { kind: "bind", path } });
		assert.equal(made.ok, false);
		assert.equal(made.error.code, "refused");
		assert.match(made.error.message, /is not below the provider's volume root/);
		assert.equal(runOf(calls()), undefined, "nothing is run");
	}
});

test("compose: a daemonCache not at or below the volume's root is refused in words when the provider is made", () => {
	const paths = layout();
	for (const daemonCache of [join(scratch, "cache-elsewhere"), join(paths.root, "..", "cache")]) {
		assert.throws(
			() => new DockerProvider({ daemonPath: "/nonexistent/computerd", daemonCache, volume: paths.volume }),
			new RegExp(`the provider's daemonCache .* is not below the provider's volume root ${paths.root} \\(the volume ${NAME}\\).*pass a daemonCache below it`),
		);
	}
	// At the root, or below it, is fine.
	for (const daemonCache of [paths.root, join(paths.root, "cache")]) assert.ok(new DockerProvider({ daemonPath: "/nonexistent/computerd", daemonCache, volume: paths.volume }));
});

test("compose: a volume option that is not a volume's name and an absolute root is refused in words", () => {
	const make = (volume) => () => new DockerProvider({ daemonPath: "/nonexistent/computerd", daemonCache: "/data/cache", volume });
	assert.throws(make({ name: "", root: "/data" }), /volume\.name "" is not a Docker volume's name/);
	assert.throws(make({ name: "a/b", root: "/data" }), /volume\.name "a\/b" is not a Docker volume's name/);
	assert.throws(make({ name: NAME, root: "data" }), /volume\.root "data" must be an absolute path/);
	assert.throws(make({ name: NAME, root: "/da,ta" }), /comma, a double quote or a line break/);
	assert.throws(make(null), /the provider's volume is \{ name, root \}/);
});

test(`compose: a Docker Engine older than ${VOLUME_SUBPATH_ENGINE}, or one with no version, is refused in words at create and then by check, before any docker run`, async () => {
	for (const [ServerVersion, reads] of [["25.0.5", "25"], ["", "no version"]]) {
		const paths = layout();
		const { provider, calls } = withVolume(paths, { info: { ServerVersion } });
		assert.deepEqual(provider.check(SPEC), [], "check knows the engine only once the host is read");
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false);
		assert.equal(made.error.code, "refused");
		assert.match(made.error.message, new RegExp(`host: Docker Engine <26 can't mount a named volume's subpath, which the provider's volume option needs: upgrade to Docker 26\\+ \\(this host's engine reads ${reads}\\)`));
		assert.equal(runOf(calls()), undefined, "nothing is run");
		assert.deepEqual(provider.check(SPEC).map(({ field }) => field), ["host"]);
	}
	// Without the option an old engine is fine: nothing needs a volume's subpath.
	const { provider } = fakeDocker({ info: { ServerVersion: "25.0.5" } });
	assert.equal((await provider.create(SPEC)).ok, true);
});

test("compose: an allowlist is refused in words by check and create, before anything is made: its proxy's code is not on the volume", async () => {
	const { provider, calls } = withVolume(layout());
	const spec = { ...SPEC, network: { allow: ["pypi.org"] } };
	assert.deepEqual(provider.check(spec).map(({ field }) => field), ["network"]);
	assert.match(provider.check(spec)[0].message, /an allowlist is not taken with the provider's volume option yet/);
	const made = await provider.create(spec);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.deepEqual(calls(), [], "no docker call");
});

test("without the volume option, create binds the daemon's copy and the run's folder as before", async () => {
	const paths = layout();
	const { provider, calls, bound } = fakeDocker();
	const made = await provider.create({ ...SPEC, mount: { kind: "bind", path: paths.work } });
	assert.equal(made.ok, true, JSON.stringify(made));
	assert.deepEqual(valuesOf(runOf(calls()), "--mount"), [`type=bind,src=${bound},dst=/opt/agentrun/computerd,readonly`, `type=bind,src=${paths.work},dst=/workspace`]);
});

test("compose: a subpath the volume does not have fails create in Docker's words, and nothing is left", async () => {
	const paths = layout();
	// The fake's volume holds another directory, so the copy's subpath is not in it, as on a volume that is not root's.
	const { provider, names } = withVolume(paths, { volumeRoots: { [NAME]: join(scratch, "empty-volume") } });
	mkdirSync(join(scratch, "empty-volume"), { recursive: true });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "docker");
	assert.match(made.error.message, /cannot access path cache\/computerd-[0-9a-f]{64} of volume agentrun_agentrun-data/);
	assert.deepEqual(names(), []);
});
