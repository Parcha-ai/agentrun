// The Docker provider's image (src/docker/image.ts), with a fake docker (fake-image-docker.mjs): no Docker is reached,
// nothing is pulled or built. A recipe is built once, on stdin with no context, tagged with its hash and labelled with
// it, and built again only when the recipe changes; an image by name is pulled when Docker has none, never built.
// Concurrent callers in one process share one build; a failure is never kept, so the next call tries again. The words
// say what happened and the next step, and hold none of Docker's output.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as index from "../dist/index.js";
import * as image from "../dist/docker/image.js";
import { create, DockerProvider } from "../dist/docker.js";
import { createProvider, DOCKER_ENV, settingsFromEnv } from "../dist/conformance/docker.js";
import { alive, fakeImageDocker, until } from "./fake-image-docker.mjs";

const { DEFAULT_DOCKER_IMAGE, DOCKER_RECIPE, DOCKER_RECIPE_HAS, ensureImage, IMAGE_REPOSITORY, IMAGE_TIMEOUT_MS, RECIPE_LABEL, recipeHash, recipeTag } = index;

const RECIPE = "FROM alpine:3.20\nRUN echo one > /one\n";
const HASH = createHash("sha256").update(RECIPE).digest("hex");
const TAG = `agentrun-computer:${HASH.slice(0, 12)}`;
const INSPECT = ["image", "inspect", "--format", "{{json .Config.Labels}}"];
const BUILD = (tag, hash) => ["build", "--quiet", "--label", `${RECIPE_LABEL}=${hash}`, "--tag", tag, "-"];
const IMAGE = "debian:bookworm-slim";
/** A marker no message may carry: Docker's own output. */
const RAW = "RAW-DOCKER-STDERR";
const OFFLINE = `ERROR: failed to solve: alpine:3.20: failed to resolve source metadata for docker.io/library/alpine:3.20: failed to do request: Head "https://registry-1.docker.io/v2/library/alpine/manifests/3.20": dial tcp: lookup registry-1.docker.io: no such host ${RAW}`;
const NO_BASE = `ERROR: failed to solve: alpine:3.20: failed to resolve source metadata for docker.io/library/alpine:3.20: pull access denied, repository does not exist or may require authorization ${RAW}`;
const DENIED = `Error response from daemon: pull access denied for nosuch/box, repository does not exist or may require 'docker login': denied: requested access to the resource is denied ${RAW}`;
const failure = (result) => {
	assert.equal(result.ok, false, `expected a failure, got ${JSON.stringify(result)}`);
	assert.ok(!result.error.message.includes(RAW), `Docker's own output is in the words: ${result.error.message}`);
	return result.error;
};

test("the names: the repository, the label and the bound; no env setting of its own", () => {
	assert.equal(IMAGE_REPOSITORY, "agentrun-computer");
	assert.equal(RECIPE_LABEL, "agentrun.computer.recipe");
	for (const name of ["DOCKER_IMAGE_ENV", "imageSourceOf"]) {
		assert.equal(name in index, false, `the index exports no ${name}: the image is an option, never read from env here`);
		assert.equal(name in image, false, `image.ts exports no ${name}`);
	}
	assert.equal(IMAGE_TIMEOUT_MS, 10 * 60_000);
	assert.equal(recipeHash(RECIPE), HASH);
	assert.equal(recipeTag(RECIPE), TAG);
});

test("the default recipe is serve's box recipe, moved: python:3.12-slim pinned by its digest, one FROM, git, curl, nodejs, npm, ripgrep and socat from apt; its tag is DEFAULT_DOCKER_IMAGE", () => {
	assert.match(DOCKER_RECIPE, /^FROM python:3\.12-slim@sha256:[0-9a-f]{64}\n/, "the base pinned by its digest");
	assert.equal([...DOCKER_RECIPE.matchAll(/^FROM /gm)].length, 1, "one FROM");
	assert.match(DOCKER_RECIPE, /apt-get install -y --no-install-recommends git curl ca-certificates nodejs npm ripgrep socat \\\n && rm -rf \/var\/lib\/apt\/lists\/\*\n$/);
	assert.equal(DOCKER_RECIPE_HAS, "python, git, curl, node, npm, rg", "serve's words for it, unchanged");
	assert.equal(DEFAULT_DOCKER_IMAGE, recipeTag(DOCKER_RECIPE));
	assert.match(DEFAULT_DOCKER_IMAGE, /^agentrun-computer:[0-9a-f]{12}$/);
});

test("a recipe is built on first use, once, on stdin with no context, tagged with its hash and labelled with it; found again with that hash, it is ready with no build", async () => {
	const fake = fakeImageDocker();
	assert.deepEqual(await ensureImage({ recipe: RECIPE }, { docker: fake.docker }), { ok: true, value: TAG });
	assert.deepEqual(fake.calls(), [[...INSPECT, TAG], BUILD(TAG, HASH)], "one inspect, one build; the recipe is the build's stdin, `-`");
	const [build] = fake.builds();
	assert.deepEqual([build.recipe, build.context], [RECIPE, "-"]);
	assert.deepEqual(fake.pulls(), [], "nothing is pulled by hand: the build pulls its base");
	assert.deepEqual(await ensureImage({ recipe: RECIPE }, { docker: fake.docker }), { ok: true, value: TAG });
	assert.deepEqual(fake.calls().slice(2), [[...INSPECT, TAG]], "found with this hash: one inspect, no build");
});

test("a recipe change builds again: another recipe's tag is not this one's, and neither is this tag with another hash or no label", async () => {
	const fake = fakeImageDocker();
	fake.keep("agentrun-computer:0123456789ab", { [RECIPE_LABEL]: "0123456789ab".padEnd(64, "0") });
	assert.equal((await ensureImage({ recipe: RECIPE }, { docker: fake.docker })).ok, true);
	assert.equal(fake.builds().length, 1, "an older recipe's image leaves this one to build");
	fake.keep(TAG, { [RECIPE_LABEL]: "f".repeat(64) });
	assert.equal((await ensureImage({ recipe: RECIPE }, { docker: fake.docker })).ok, true);
	assert.equal(fake.builds().length, 2, "this tag with another hash is built again");
	fake.keep(TAG, null);
	assert.equal((await ensureImage({ recipe: RECIPE }, { docker: fake.docker })).ok, true);
	assert.equal(fake.builds().length, 3, "and so is one with no label at all");
});

test("concurrent callers in one process share one build; once it settles, the next caller inspects again and finds it", async () => {
	const fake = fakeImageDocker({ "build-hold": "" });
	const callers = Array.from({ length: 5 }, () => ensureImage({ recipe: RECIPE }, { docker: fake.docker }));
	await until(() => fake.builds().length === 1, "the build");
	await new Promise((resolve) => setTimeout(resolve, 100));
	fake.clear("build-hold");
	for (const result of await Promise.all(callers)) assert.deepEqual(result, { ok: true, value: TAG });
	assert.equal(fake.builds().length, 1, "one build for five callers");
	assert.deepEqual(fake.calls(), [[...INSPECT, TAG], BUILD(TAG, HASH)], "the four that joined asked Docker nothing");
	assert.deepEqual(await ensureImage({ recipe: RECIPE }, { docker: fake.docker }), { ok: true, value: TAG });
	assert.deepEqual(fake.calls().slice(2), [[...INSPECT, TAG]]);
	// Another recipe is another flight.
	const other = "FROM alpine:3.20\nRUN echo two > /two\n";
	const [a, b] = await Promise.all([ensureImage({ recipe: RECIPE }, { docker: fake.docker }), ensureImage({ recipe: other }, { docker: fake.docker })]);
	assert.deepEqual([a.value, b.value], [TAG, recipeTag(other)]);
	assert.deepEqual(fake.builds().map((build) => build.tag), [TAG, recipeTag(other)]);
});

test("a caller's abort ends its own wait only, and the build goes on for the others; when the last caller waiting aborts, the build is stopped and the next call builds again", async () => {
	const fake = fakeImageDocker({ "build-hold": "" });
	const leaving = new AbortController();
	const left = ensureImage({ recipe: RECIPE }, { docker: fake.docker, signal: leaving.signal });
	const stays = ensureImage({ recipe: RECIPE }, { docker: fake.docker });
	await until(() => fake.builds().length === 1, "the build");
	leaving.abort();
	const aborted = failure(await left);
	assert.deepEqual(aborted, { code: "aborted", message: `the wait for ${TAG} was aborted; the build goes on for the other callers waiting on it` });
	assert.equal(alive(fake.builds()[0].pid), true, "the build goes on");
	fake.clear("build-hold");
	assert.deepEqual(await stays, { ok: true, value: TAG });
	assert.equal(fake.builds().length, 1);

	const other = "FROM alpine:3.20\nRUN echo three > /three\n";
	fake.mark("build-hold");
	const one = new AbortController();
	const two = new AbortController();
	const first = ensureImage({ recipe: other }, { docker: fake.docker, signal: one.signal });
	const second = ensureImage({ recipe: other }, { docker: fake.docker, signal: two.signal });
	await until(() => fake.builds().length === 2, "the second recipe's build");
	const { pid } = fake.builds()[1];
	one.abort();
	assert.match(failure(await first).message, /goes on for the other callers/);
	two.abort();
	assert.deepEqual(failure(await second), { code: "aborted", message: `the wait for ${recipeTag(other)} was aborted, and the build, which no other caller waited on, was stopped` });
	await until(() => !alive(pid), "the stopped build's docker to end", 5_000);
	assert.equal(fake.has(recipeTag(other)), false, "nothing was tagged");
	fake.clear("build-hold");
	assert.deepEqual(await ensureImage({ recipe: other }, { docker: fake.docker }), { ok: true, value: recipeTag(other) });
	assert.equal(fake.builds().length, 3, "a stopped build is not kept: the next call builds again");

	const before = fake.calls().length;
	const gone = AbortSignal.abort();
	assert.deepEqual(failure(await ensureImage({ recipe: RECIPE }, { docker: fake.docker, signal: gone })), { code: "aborted", message: `the wait for ${TAG} was aborted before it began` });
	assert.equal(fake.calls().length, before, "an aborted signal calls no docker");
});

test("a build past its bound is stopped, in words, and the next call builds again; the first caller's bound is the flight's", async () => {
	const fake = fakeImageDocker({ "build-hold": "" });
	const started = Date.now();
	const late = ensureImage({ recipe: RECIPE }, { docker: fake.docker, timeoutMs: 1_000 });
	const joined = ensureImage({ recipe: RECIPE }, { docker: fake.docker, timeoutMs: 60_000 });
	const message = `the build of ${TAG} did not finish within 1 s, so it was stopped: call again to build it again`;
	assert.deepEqual(failure(await late), { code: "timeout", message });
	assert.deepEqual(failure(await joined), { code: "timeout", message }, "a caller that joined shares the flight's bound");
	assert.ok(Date.now() - started < 10_000, "the bound ends the build");
	await until(() => !alive(fake.builds()[0].pid), "the stopped build's docker to end", 5_000);
	fake.clear("build-hold");
	assert.deepEqual(await ensureImage({ recipe: RECIPE }, { docker: fake.docker }), { ok: true, value: TAG });
	assert.equal(fake.builds().length, 2);
});

test("a build that fails says why and the next step, with none of Docker's output; a failure is not kept", async () => {
	const fake = fakeImageDocker();
	const said = async (stderr) => {
		fake.mark("build-fail", stderr);
		return failure(await ensureImage({ recipe: RECIPE }, { docker: fake.docker }));
	};
	assert.deepEqual(await said(OFFLINE), { code: "vendor", vendor: "docker", message: `the build of ${TAG} could not reach the network (it pulls alpine:3.20): call again once this machine can reach it` });
	assert.deepEqual(await said(`Err:1 http://deb.debian.org/debian bookworm InRelease Temporary failure resolving 'deb.debian.org' ${RAW}`), {
		code: "vendor",
		vendor: "docker",
		message: `the build of ${TAG} could not reach the network (it pulls alpine:3.20): call again once this machine can reach it`,
	});
	assert.deepEqual(await said(NO_BASE), { code: "vendor", vendor: "docker", message: `the build of ${TAG} could not pull its base, alpine:3.20: name a base the registry has, or pull it on this machine first` });
	assert.deepEqual(await said(`failed to copy files: write /var/lib/docker/x: no space left on device ${RAW}`), { code: "vendor", vendor: "docker", message: `the build of ${TAG} ran out of disk space: free some, then call again` });
	const PACKAGE = { code: "vendor", vendor: "docker", message: `the recipe of ${TAG} names a package its base's package manager could not install: check the names, then call again` };
	assert.deepEqual(await said(`E: Unable to locate package nosuch ${RAW}`), PACKAGE);
	assert.deepEqual(await said(`ERROR: unable to select packages:\n  nosuch (no such package): ${RAW}`), PACKAGE, "apk's words too");
	assert.deepEqual(await said(`ERROR: failed to build: failed to solve: dockerfile parse error on line 2: unknown instruction: BOGUS ${RAW}`), {
		code: "vendor",
		vendor: "docker",
		message: `Docker could not parse the recipe of ${TAG} at line 2: fix that line`,
	});
	assert.deepEqual(await said(`#5 0.2 ${RAW}\nERROR: failed to build: failed to solve: process "/bin/sh -c test \\"a\\" = b" did not complete successfully: exit code: 1`), {
		code: "vendor",
		vendor: "docker",
		message: `the recipe of ${TAG} failed at the step \`RUN test "a" = b\` with exit code 1: fix that step`,
	});
	assert.deepEqual(await said(`The command '/bin/sh -c exit 3' returned a non-zero code: 3 ${RAW}`), {
		code: "vendor",
		vendor: "docker",
		message: `the recipe of ${TAG} failed at the step \`RUN exit 3\` with exit code 3: fix that step`,
	}, "the legacy builder's words too");
	assert.deepEqual(await said(`something else entirely ${RAW}`), {
		code: "vendor",
		vendor: "docker",
		message: `docker build of ${TAG} failed (exit 1): run docker build with the recipe on this machine to see why`,
	});
	assert.equal(fake.builds().length, 10, "every call built again: no failure is kept");
	fake.clear("build-fail");
	assert.deepEqual(await ensureImage({ recipe: RECIPE }, { docker: fake.docker }), { ok: true, value: TAG });
});

test("a build or pull that fails because another process tagged the image first asks Docker again: the tag on this recipe's image, or the image by name, is ready", async () => {
	const fake = fakeImageDocker({ "build-race": "" });
	assert.deepEqual(await ensureImage({ recipe: RECIPE }, { docker: fake.docker }), { ok: true, value: TAG });
	assert.deepEqual(fake.calls(), [[...INSPECT, TAG], BUILD(TAG, HASH), [...INSPECT, TAG]], "the build lost the race to the tag; one inspect more finds the winner's");
	fake.clear("build-race");
	fake.mark("pull-race");
	assert.deepEqual(await ensureImage({ image: IMAGE }, { docker: fake.docker }), { ok: true, value: IMAGE });
	assert.deepEqual(fake.calls().slice(3), [[...INSPECT, IMAGE], ["pull", "--quiet", IMAGE], [...INSPECT, IMAGE]]);
	// A failed build whose tag holds another recipe's image after it is still a failure, in its own words.
	const other = "FROM alpine:3.20\nRUN echo four > /four\n";
	fake.mark("build-fail", `E: Unable to locate package nosuch ${RAW}`);
	fake.keep(recipeTag(other), { [RECIPE_LABEL]: "f".repeat(64) });
	assert.match(failure(await ensureImage({ recipe: other }, { docker: fake.docker })).message, /names a package its base's package manager could not install/);
	assert.deepEqual(fake.calls().slice(6), [[...INSPECT, recipeTag(other)], BUILD(recipeTag(other), recipeHash(other)), [...INSPECT, recipeTag(other)]]);
});

test("an onWait that aborts its own caller's signal settles that caller as aborted at once, joining a build under way or starting one; the build goes on for the others", { timeout: 30_000 }, async () => {
	const fake = fakeImageDocker({ "build-hold": "" });
	/** The call's result, or "still waiting" when it has not settled within ms: the build is held far longer. */
	const within = (call, ms = 2_000) => Promise.race([call, new Promise((resolve) => setTimeout(() => resolve("still waiting"), ms))]);
	const stays = ensureImage({ recipe: RECIPE }, { docker: fake.docker });
	await until(() => fake.builds().length === 1, "the build");
	// Joins the build under way: onWait is told at once, before ensureImage returns, and aborts the caller's own signal.
	const leaving = new AbortController();
	const left = ensureImage({ recipe: RECIPE }, { docker: fake.docker, signal: leaving.signal, onWait: () => leaving.abort() });
	assert.deepEqual(await within(left), { ok: false, error: { code: "aborted", message: `the wait for ${TAG} was aborted; the build goes on for the other callers waiting on it` } });
	assert.equal(alive(fake.builds()[0].pid), true, "the build goes on for the caller still waiting");
	fake.clear("build-hold");
	assert.deepEqual(await stays, { ok: true, value: TAG });
	assert.equal(fake.builds().length, 1);

	// Starts the flight itself and is its only caller: onWait, told before the build begins, aborts it, and no build starts.
	const other = "FROM alpine:3.20\nRUN echo seven > /seven\n";
	fake.mark("build-hold");
	const alone = new AbortController();
	const stopped = ensureImage({ recipe: other }, { docker: fake.docker, signal: alone.signal, onWait: () => alone.abort() });
	assert.deepEqual(await within(stopped), { ok: false, error: { code: "aborted", message: `the wait for ${recipeTag(other)} was aborted, and the build, which no other caller waited on, was stopped` } });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(fake.calls().filter(([command]) => command === "build").length, 1, "no docker build was started for it");
	fake.clear("build-hold");
	assert.deepEqual(await ensureImage({ recipe: other }, { docker: fake.docker }), { ok: true, value: recipeTag(other) }, "the next call builds it");
});

test("onWait is told once, before a caller waits on a build or pull, its own or one it joined; never when Docker has the image; a throw from it changes nothing", async () => {
	const fake = fakeImageDocker({ "build-hold": "" });
	const told = [];
	const first = ensureImage({ recipe: RECIPE }, { docker: fake.docker, onWait: (making, tag) => told.push(["first", making, tag]) });
	await until(() => fake.builds().length === 1, "the build");
	assert.deepEqual(told, [["first", "build", TAG]]);
	const joined = ensureImage({ recipe: RECIPE }, { docker: fake.docker, onWait: (making, tag) => told.push(["joined", making, tag]) });
	await until(() => told.length === 2, "the joiner told");
	assert.deepEqual(told[1], ["joined", "build", TAG], "a caller that joins a build under way is told at once");
	fake.clear("build-hold");
	assert.deepEqual([await first, await joined], [{ ok: true, value: TAG }, { ok: true, value: TAG }]);
	assert.deepEqual(await ensureImage({ recipe: RECIPE }, { docker: fake.docker, onWait: () => told.push(["found"]) }), { ok: true, value: TAG });
	assert.equal(told.length, 2, "not told when Docker has the image");
	assert.deepEqual(await ensureImage({ image: IMAGE }, { docker: fake.docker, onWait: (making, tag) => told.push([making, tag]) }), { ok: true, value: IMAGE });
	assert.deepEqual(told[2], ["pull", IMAGE]);
	const other = "FROM alpine:3.20\nRUN echo five > /five\n";
	assert.deepEqual(await ensureImage({ recipe: other }, { docker: fake.docker, onWait: () => { throw new Error("a broken listener"); } }), { ok: true, value: recipeTag(other) });
	const provider = new DockerProvider({ daemonPath: fake.docker, docker: fake.docker, image: { recipe: "FROM alpine:3.20\nRUN echo six > /six\n" } });
	const byProvider = [];
	assert.equal((await provider.image({ onWait: (making) => byProvider.push(making) })).ok, true);
	assert.deepEqual(byProvider, ["build"], "image() passes onWait on");
});

test("an image by name: one Docker has is ready with one inspect, nothing pulled or built; one it has not is pulled once, never built; concurrent callers share the pull", async () => {
	const fake = fakeImageDocker();
	fake.keep(IMAGE, {});
	assert.deepEqual(await ensureImage({ image: IMAGE }, { docker: fake.docker }), { ok: true, value: IMAGE });
	assert.deepEqual(fake.calls(), [[...INSPECT, IMAGE]]);
	const other = "alpine:3.20";
	fake.mark("pull-hold");
	const callers = [ensureImage({ image: other }, { docker: fake.docker }), ensureImage({ image: other }, { docker: fake.docker })];
	await until(() => fake.pulls().length === 1, "the pull");
	fake.clear("pull-hold");
	for (const result of await Promise.all(callers)) assert.deepEqual(result, { ok: true, value: other });
	assert.deepEqual(fake.calls().slice(1), [[...INSPECT, other], ["pull", "--quiet", other]], "one pull of it");
	assert.deepEqual(fake.builds(), [], "never built");
	assert.deepEqual(await ensureImage({ image: other }, { docker: fake.docker }), { ok: true, value: other });
	assert.equal(fake.pulls().length, 1, "pulled once");
});

test("a docker that is Podman, saying `image not known`, has the image pulled or built as Docker's would", async () => {
	const fake = fakeImageDocker({ "podman-words": "" });
	assert.deepEqual(await ensureImage({ image: IMAGE }, { docker: fake.docker }), { ok: true, value: IMAGE });
	assert.equal(fake.pulls().length, 1);
	assert.deepEqual(await ensureImage({ recipe: RECIPE }, { docker: fake.docker }), { ok: true, value: TAG });
	assert.equal(fake.builds().length, 1);
});

test("a pull that fails, or passes its bound, says why and the next step, with none of Docker's output", async () => {
	const fake = fakeImageDocker();
	const said = async (stderr) => {
		fake.mark("pull-fail", stderr);
		return failure(await ensureImage({ image: "nosuch/box:1" }, { docker: fake.docker }));
	};
	const see = "run docker pull nosuch/box:1 on this machine to see why";
	assert.deepEqual(await said(DENIED), { code: "vendor", vendor: "docker", message: `the registry refused the pull of nosuch/box:1 (no such repository, or it needs a docker login): ${see}` });
	assert.deepEqual(await said(`Error response from daemon: manifest for nosuch/box:1 not found: manifest unknown ${RAW}`), {
		code: "vendor",
		vendor: "docker",
		message: "the registry has no nosuch/box:1: name an image it has",
	});
	assert.deepEqual(await said(`Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: connection refused ${RAW}`), {
		code: "vendor",
		vendor: "docker",
		message: `the registry could not be reached to pull nosuch/box:1: ${see}`,
	});
	assert.deepEqual(await said(`odd ${RAW}`), { code: "vendor", vendor: "docker", message: `docker pull nosuch/box:1 failed (exit 1): ${see}` });
	assert.equal(fake.pulls().length, 4, "no failure is kept");
	fake.clear("pull-fail");
	fake.mark("pull-hold");
	const started = Date.now();
	assert.deepEqual(failure(await ensureImage({ image: "nosuch/box:1" }, { docker: fake.docker, timeoutMs: 1_000 })), {
		code: "timeout",
		message: "the pull of nosuch/box:1 did not finish within 1 s, so it was stopped: run docker pull nosuch/box:1 on this machine, or call again",
	});
	assert.ok(Date.now() - started < 10_000);
	assert.equal(fake.pulls().length, 5, "a pull past its bound is not tried again within the call");
});

test("an inspect that fails, not for want of the image, builds and pulls nothing: Docker not answering, another failure, an inspect past its bound, no docker CLI", async () => {
	const fake = fakeImageDocker({ "inspect-fail": `Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running? ${RAW}` });
	assert.deepEqual(failure(await ensureImage({ recipe: RECIPE }, { docker: fake.docker })), {
		code: "vendor",
		vendor: "docker",
		message: `Docker did not answer docker image inspect ${TAG}: is it running, and may this user reach it?`,
	});
	fake.mark("inspect-fail", `strange ${RAW}`);
	assert.deepEqual(failure(await ensureImage({ image: IMAGE }, { docker: fake.docker })), {
		code: "vendor",
		vendor: "docker",
		message: `docker image inspect ${IMAGE} failed (exit 1): run it on this machine as this process's user to see why`,
	});
	fake.clear("inspect-fail");
	fake.mark("inspect-hold");
	assert.deepEqual(failure(await ensureImage({ recipe: RECIPE }, { docker: fake.docker, timeoutMs: 1_000 })), {
		code: "timeout",
		message: `docker image inspect ${TAG} did not answer within 1 s, so it was stopped: call again`,
	});
	assert.deepEqual([fake.builds(), fake.pulls()], [[], []]);
	assert.deepEqual(failure(await ensureImage({ recipe: RECIPE }, { docker: "/nonexistent/docker" })), { code: "vendor", vendor: "docker", message: "the docker CLI (/nonexistent/docker) was not found" });
});

test("a build or pull that fails, and whose second inspect the bound stops, fails as the timeout, not as the build's or pull's failure", async () => {
	for (const [source, step, tag] of [
		[{ recipe: RECIPE }, "build", TAG],
		[{ image: IMAGE }, "pull", IMAGE],
	]) {
		const fake = fakeImageDocker({ [`${step}-fail`]: `odd ${RAW}`, "then-inspect-hold": "" });
		assert.deepEqual(failure(await ensureImage(source, { docker: fake.docker, timeoutMs: 1_000 })), {
			code: "timeout",
			message: `docker image inspect ${tag} did not answer within 1 s, so it was stopped: call again`,
		}, step);
	}
});

test("a source that is neither a recipe nor an image name, or a bound that is not one, is refused before Docker is called", async () => {
	const fake = fakeImageDocker();
	const SOURCE = "an image source is { recipe } or { image }, one of them";
	const RECIPE_WORDS = "a recipe is the text of a Dockerfile with a FROM line and no NUL byte; it is built with no context";
	const IMAGE_WORDS = 'an image is a name such as debian:bookworm-slim: not empty, with no space or NUL byte, not starting with "-"';
	const cases = [
		[undefined, SOURCE],
		[null, SOURCE],
		[{}, SOURCE],
		[{ recipe: RECIPE, image: IMAGE }, SOURCE],
		[{ recipe: "" }, RECIPE_WORDS],
		[{ recipe: "RUN echo no base\n" }, RECIPE_WORDS],
		[{ recipe: `${RECIPE}\0` }, RECIPE_WORDS],
		[{ recipe: 7 }, RECIPE_WORDS],
		[{ image: "" }, IMAGE_WORDS],
		[{ image: "-v" }, IMAGE_WORDS],
		[{ image: "a b" }, IMAGE_WORDS],
		[{ image: "a\0" }, IMAGE_WORDS],
	];
	for (const [source, message] of cases) assert.deepEqual(failure(await ensureImage(source, { docker: fake.docker })), { code: "invalid", message }, JSON.stringify(source));
	for (const timeoutMs of [0, -1, 1.5, 2 ** 31, Number.NaN, "60000"]) {
		assert.deepEqual(failure(await ensureImage({ recipe: RECIPE }, { docker: fake.docker, timeoutMs })), {
			code: "invalid",
			message: `timeoutMs must be a whole number of milliseconds above 0 and at most 2147483647, not ${JSON.stringify(timeoutMs) ?? String(timeoutMs)}`,
		});
	}
	assert.deepEqual(fake.calls(), [], "Docker was never called");
});

test("DockerProvider.image(): the default recipe, or the source it was given, through its own docker CLI", async () => {
	const fake = fakeImageDocker();
	const provider = new DockerProvider({ daemonPath: fake.docker, docker: fake.docker });
	assert.deepEqual(await provider.image(), { ok: true, value: DEFAULT_DOCKER_IMAGE });
	assert.deepEqual(fake.calls(), [[...INSPECT, DEFAULT_DOCKER_IMAGE], BUILD(DEFAULT_DOCKER_IMAGE, recipeHash(DOCKER_RECIPE))]);
	assert.equal(fake.builds()[0].recipe, DOCKER_RECIPE);
	fake.keep(IMAGE, {});
	const named = new DockerProvider({ daemonPath: fake.docker, docker: fake.docker, image: { image: IMAGE } });
	assert.deepEqual(await named.image(), { ok: true, value: IMAGE });
	assert.deepEqual(fake.calls().slice(2), [[...INSPECT, IMAGE]]);
	fake.mark("build-hold");
	const built = new DockerProvider({ daemonPath: fake.docker, docker: fake.docker, image: { recipe: RECIPE } });
	assert.deepEqual(failure(await built.image({ timeoutMs: 1_000 })).code, "timeout", "image() takes a bound");
	assert.deepEqual(failure(await built.image({ signal: AbortSignal.abort() })).code, "aborted", "and a signal");
	assert.throws(() => new DockerProvider({ daemonPath: fake.docker, image: { recipe: "no base" } }), /^Error: the provider's image: a recipe is the text of a Dockerfile with a FROM line/);
});

test("create() takes the image only as an option, and the conformance module reads no image name: a COMPUTER_DOCKER_IMAGE in env is ignored", async () => {
	assert.equal("image" in DOCKER_ENV, false, "the conformance module's names hold no image setting");
	const fake = fakeImageDocker();
	const daemon = { COMPUTER_DOCKER_DAEMON: fake.docker };
	fake.keep(IMAGE, {});
	// In env, a name Docker has, an empty one and one that is not a name at all: each ignored, the provider's own recipe.
	for (const env of [daemon, { ...daemon, COMPUTER_DOCKER_IMAGE: IMAGE }, { ...daemon, COMPUTER_DOCKER_IMAGE: "" }, { ...daemon, COMPUTER_DOCKER_IMAGE: "-v" }]) {
		assert.equal("image" in settingsFromEnv(env), false, JSON.stringify(env));
		const own = await createProvider({ env, docker: fake.docker });
		assert.deepEqual(await own.image(), { ok: true, value: DEFAULT_DOCKER_IMAGE }, JSON.stringify(env));
	}
	assert.deepEqual(fake.builds().map((build) => build.recipe), [DOCKER_RECIPE], "the provider's own recipe, built once");
	assert.equal(fake.calls().some((args) => args.includes(IMAGE)), false, "Docker is never asked for the image named in env");
	const named = await create({ daemonPath: fake.docker, docker: fake.docker, image: { image: IMAGE } });
	assert.deepEqual(await named.image(), { ok: true, value: IMAGE }, "the image option is the one way to name another image");
	const given = await create({ daemonPath: fake.docker, docker: fake.docker, image: { recipe: RECIPE } });
	assert.deepEqual(await given.image(), { ok: true, value: TAG });
	await assert.rejects(create({ daemonPath: fake.docker, docker: fake.docker, image: { image: "-v" } }), /^Error: the provider's image: an image is a name/, "a bad option is the constructor's refusal");
});
