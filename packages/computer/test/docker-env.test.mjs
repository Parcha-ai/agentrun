// The docker CLI's environment: each docker call the Docker provider makes is started with the names docker reads (where
// the daemon is, its config and credential helpers, PATH and HOME) of the environment its host passes (the `env`
// option), and none of the rest, so a key the server holds never reaches a docker child. The key is in this process's
// environment as well, so a docker call that inherits it is caught too. Against the fake docker programs (fake-docker.mjs,
// fake-image-docker.mjs), which record each call's environment; no Docker is reached.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { dockerArch } from "../dist/docker.js";
import { ensureImage } from "../dist/docker/image.js";
import { fakeDocker } from "./fake-docker.mjs";
import { fakeImageDocker } from "./fake-image-docker.mjs";

/** A name shaped as a key, and one that is plain but no name docker reads: neither reaches docker. */
const KEY = "FOO_API_KEY";
const PLAIN = "AGENTRUN_UNLISTED_SETTING";
const config = mkdtempSync(join(tmpdir(), "computer-docker-env-"));
/** What docker reads, set here so each call shows it: where the daemon is, and where its config (and so its credential
 *  helpers) is. */
const NEEDED = { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: config };
const was = {};

before(() => {
	for (const name of [KEY, PLAIN, ...Object.keys(NEEDED)]) was[name] = process.env[name];
	process.env[KEY] = `not-a-secret-${"canary"}`;
	process.env[PLAIN] = "plain";
	Object.assign(process.env, NEEDED);
});
after(() => {
	for (const [name, value] of Object.entries(was)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(config, { recursive: true, force: true });
});

/** The environment the host passes: this process's, the key and the plain name included. */
const hostEnv = () => ({ ...process.env });

/** Each recorded call holds no key and no unlisted name, and holds what docker reads: PATH, HOME, DOCKER_HOST and
 *  DOCKER_CONFIG, as this process has them. */
function onlyWhatDockerReads(envs, what) {
	assert.ok(envs.length > 0, `${what}: no docker call was recorded`);
	for (const { args, names, seen } of envs) {
		assert.ok(!names.includes(KEY), `${what}: ${KEY} reached docker ${args.slice(0, 2).join(" ")}`);
		assert.ok(!names.includes(PLAIN), `${what}: ${PLAIN}, a name docker never reads, reached docker ${args.slice(0, 2).join(" ")}`);
		assert.deepEqual(seen, { PATH: process.env.PATH, HOME: process.env.HOME, ...NEEDED }, `${what}: docker ${args.slice(0, 2).join(" ")} has what it reads`);
	}
}

test("list(): docker ps and inspect are started with what docker reads alone, never a key", async () => {
	const { provider, envs } = fakeDocker({ env: hostEnv() });
	const listed = await provider.list({});
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.ok(envs().some((e) => e.args[0] === "ps"), "list ran docker ps");
	onlyWhatDockerReads(envs(), "list");
});

test("create(): docker info, run and inspect are started with what docker reads alone, never a key", async () => {
	const { provider, envs } = fakeDocker({ env: hostEnv() });
	const made = await provider.create({ image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" }, { requestId: "docker-env-create" });
	assert.equal(made.ok, true, JSON.stringify(made));
	assert.ok(envs().some((e) => e.args[0] === "run"), "create ran docker run");
	onlyWhatDockerReads(envs(), "create");
});

test("connect(): docker exec of the daemon is started with what docker reads alone, never a key", async () => {
	const { provider, envs } = fakeDocker({ env: hostEnv() });
	const connected = await provider.connect({ id: "f".repeat(64), name: "computer-0123456789ab" });
	assert.equal(connected.ok, true, JSON.stringify(connected));
	await connected.value.close();
	assert.deepEqual(envs().map((e) => e.args[0]), ["exec"]);
	onlyWhatDockerReads(envs(), "connect");
});

test("dockerArch(): docker version is started with what docker reads alone, never a key", async () => {
	const { program, envs } = fakeDocker();
	assert.equal(await dockerArch({ docker: program, env: hostEnv() }), "amd64");
	assert.deepEqual(envs().map((e) => e.args[0]), ["version"]);
	onlyWhatDockerReads(envs(), "dockerArch");
});

test("ensureImage(): docker image inspect and pull, which read the credential helpers through DOCKER_CONFIG, HOME and PATH, are started with what docker reads alone, never a key", async () => {
	const fake = fakeImageDocker();
	const image = "registry.example.com/team/box:1";
	assert.deepEqual(await ensureImage({ image }, { docker: fake.docker, env: hostEnv() }), { ok: true, value: image });
	assert.ok(fake.envs().some((e) => e.args[0] === "pull"), "the image was pulled");
	onlyWhatDockerReads(fake.envs(), "ensureImage");
});

test("ensureImage(): two calls at once for the same image on two Docker hosts each pull on their own host, never one sharing the other's pull", async () => {
	// The pulls are held until both have started (or 5 s pass), so neither host's pull is done before the other's inspect:
	// the fake keeps one set of images for both hosts.
	const fake = fakeImageDocker({ "pull-hold": "" });
	const image = "registry.example.com/team/box:2";
	const hosts = ["unix:///run/one/docker.sock", "unix:///run/two/docker.sock"];
	const asked = Promise.all(hosts.map((DOCKER_HOST) => ensureImage({ image }, { docker: fake.docker, env: { ...hostEnv(), DOCKER_HOST } })));
	for (let waited = 0; waited < 5000 && fake.pulls().length < hosts.length; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
	fake.clear("pull-hold");
	assert.deepEqual(await asked, [{ ok: true, value: image }, { ok: true, value: image }]);
	const pulledOn = fake.envs().filter((e) => e.args[0] === "pull").map((e) => e.seen.DOCKER_HOST).sort();
	assert.deepEqual(pulledOn, hosts, `each host pulls the image itself: pulls went to ${JSON.stringify(pulledOn)}`);
});

test("given no env, the provider, dockerArch() and ensureImage() start docker with none of this process's environment", async () => {
	const { provider, program, envs } = fakeDocker();
	assert.equal((await provider.list({})).ok, true);
	assert.equal(await dockerArch({ docker: program }), "amd64");
	const fake = fakeImageDocker();
	assert.deepEqual(await ensureImage({ image: "registry.example.com/team/box:1" }, { docker: fake.docker }), { ok: true, value: "registry.example.com/team/box:1" });
	for (const { args, names } of [...envs(), ...fake.envs()]) {
		assert.deepEqual(names, [], `no env: docker ${args.slice(0, 2).join(" ")} was started with this process's environment`);
	}
});
