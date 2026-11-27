// The media box image (media/Dockerfile), read as text: no network, no docker. It is the Docker box's default image and
// more, for an agent that renders video: the same base digest as DOCKER_RECIPE, every program the default recipe installs
// (but Debian's nodejs and npm, which Node's own tarball replaces), Node 22 or later from nodejs.org pinned by sha256 for
// each architecture, Chromium (`chrome` on PATH), FFmpeg and FFprobe, fonts for titles, and the HyperFrames CLI at an
// exact version. It names no key and no second image picker: an operator builds it and names its tag in
// AGENTRUN_DOCKER_IMAGE. The package ships it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DOCKER_BASE, DOCKER_RECIPE } from "../dist/index.js";
import { snapshotApt } from "./snapshot-apt.mjs";

const DOCKERFILE = readFileSync(new URL("../media/Dockerfile", import.meta.url), "utf8");
/** The Dockerfile's instructions, a line each, continuation lines joined, comments out. */
const INSTRUCTIONS = DOCKERFILE.replace(/\\\n/g, " ").split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
const RUNS = INSTRUCTIONS.filter((line) => line.startsWith("RUN ")).join("\n");
/** The packages an apt-get install line names. */
const aptOf = (text) => [...text.replace(/\\\n/g, " ").matchAll(/apt-get install -y --no-install-recommends ([^&]+)/g)].flatMap((match) => match[1].trim().split(/\s+/));

test("it starts from the default recipe's base, pinned by the same digest, and is one stage", () => {
  const froms = INSTRUCTIONS.filter((line) => line.startsWith("FROM "));
  assert.deepEqual(froms, [`FROM ${DOCKER_BASE}`]);
  assert.match(DOCKER_BASE, /@sha256:[0-9a-f]{64}$/);
});

test("it has every program the default recipe installs, Node from its own tarball in place of Debian's nodejs and npm", () => {
  const ours = aptOf(RUNS);
  for (const name of aptOf(DOCKER_RECIPE)) {
    if (name === "nodejs" || name === "npm") continue;
    assert.ok(ours.includes(name), `${name} is installed`);
  }
  assert.ok(!ours.includes("nodejs"), "Debian's nodejs is older than HyperFrames' Node 22 floor");
});

test("Node comes from nodejs.org at one version of 22 or later, checked against a sha256 for each architecture before it is unpacked", () => {
  const versions = [...new Set([...RUNS.matchAll(/nodejs\.org\/dist\/v(\d+)\.(\d+)\.(\d+)\//g)].map((match) => match.slice(1).join(".")))];
  assert.equal(versions.length, 1, `one Node version: ${versions}`);
  assert.ok(Number(versions[0].split(".")[0]) >= 22, versions[0]);
  for (const arch of ["amd64", "arm64"]) assert.match(RUNS, new RegExp(`${arch}\\) arch=\\w+; sum=[0-9a-f]{64} ;;`), arch);
  assert.ok(RUNS.indexOf("sha256sum -c") < RUNS.indexOf("tar -xJf"), "checked before unpacked");
});

test("it has Chromium as chrome, FFmpeg and FFprobe, title fonts and the HyperFrames CLI at an exact version", () => {
  const ours = aptOf(RUNS);
  for (const name of ["chromium", "ffmpeg", "fonts-noto-core", "fonts-noto-cjk", "fonts-noto-color-emoji", "fonts-liberation"]) assert.ok(ours.includes(name), name);
  assert.match(RUNS, /ln -s \/usr\/bin\/chromium \/usr\/local\/bin\/chrome/, "chrome on PATH is Chromium");
  assert.match(RUNS, /npm install --global --ignore-scripts --before=\S+ hyperframes@\d+\.\d+\.\d+ /, "an exact version, no install script, the registry as it was");
});

test("its Debian packages come from snapshot.debian.org over https at one instant, the instant npm's --before names, never from the live mirror", () => {
  const instant = snapshotApt(RUNS);
  const before = RUNS.match(/--before=(\S+)/)[1];
  assert.equal(new Date(before).toISOString(), instant, "apt and npm are pinned to one instant");
});

test("it holds no key and picks nothing: no ENV, ARG or secret mount, and its build command names AGENTRUN_DOCKER_IMAGE", () => {
  assert.deepEqual(INSTRUCTIONS.filter((line) => /^(ENV|ARG|ENTRYPOINT|CMD|USER) /.test(line)), []);
  assert.doesNotMatch(DOCKERFILE, /--mount=type=secret|KEY|TOKEN/);
  assert.match(DOCKERFILE, /docker build -t "\$tag" - < packages\/computer\/media\/Dockerfile/);
  assert.match(DOCKERFILE, /AGENTRUN_DOCKER_IMAGE=\$tag/);
});

test("its HyperFrames reports nothing home and checks for no update, unless the caller says otherwise: a box's work stays in the box", () => {
  for (const name of ["HYPERFRAMES_NO_TELEMETRY", "HYPERFRAMES_NO_UPDATE_CHECK"]) {
    assert.match(RUNS, new RegExp(`export ${name}="\\$\\{${name}:-1\\}"`), name);
  }
});

// With no network HyperFrames embeds a system font it can't fetch from Google Fonts, compressed to WOFF2 in WASM: about a
// minute of CPU for Noto Color Emoji alone, on every render, since a box's cache starts empty. The image compresses each
// of its fonts once, at build, by HyperFrames' own fontToDataUri into the cache HyperFrames names under
// HYPERFRAMES_FONT_CACHE_DIR (its key, its bytes and its folder's name, never a copy of its scheme), so a HyperFrames that
// renames that folder bakes the new name, and the script links whatever folders the build made.
const BAKED = "/usr/local/share/hyperframes/fonts";
test("its system fonts are compressed for HyperFrames at build, by HyperFrames itself, into the folder HyperFrames names", () => {
  const fill = INSTRUCTIONS.findIndex((line) => line.startsWith("RUN ") && line.includes("fontToDataUri"));
  assert.ok(fill > 0, "a RUN fills the cache with HyperFrames' fontToDataUri");
  assert.ok(fill > INSTRUCTIONS.findIndex((line) => /npm install --global .*hyperframes@/.test(line)), "after HyperFrames is installed");
  assert.match(INSTRUCTIONS[fill], /\/usr\/share\/fonts/, "from the image's own fonts");
  assert.match(INSTRUCTIONS[fill], new RegExp(`HYPERFRAMES_FONT_CACHE_DIR=${BAKED}[ "]`), "HyperFrames' cache root named, so HyperFrames picks the folder under it");
  assert.doesNotMatch(INSTRUCTIONS[fill], /cacheDir/, "no folder of ours passed in its place");
  assert.doesNotMatch(DOCKERFILE.replace(/^#.*$/gm, ""), /compression-v\d/, "no HyperFrames folder name written down, in the build or the script");
});

// The `hyperframes` script, as the Dockerfile writes it (its build cache root moved to a folder of the test's), run by sh
// with its last line (exec node) swapped for one that says the font cache it hands HyperFrames. That cache stays in HOME,
// writable, as HyperFrames' Google Fonts downloads need it to be (a read-only one makes HyperFrames warn "unwritable ...
// chmod 755" on every render), and each folder the build made under its root is linked into it by name. A cache the
// caller names is left alone.
function wrapper(baked = BAKED) {
  const block = DOCKERFILE.slice(DOCKERFILE.indexOf("printf '%s\\n'"), DOCKERFILE.indexOf("> /usr/local/bin/hyperframes"));
  const lines = [...block.slice("printf '%s\\n'".length).matchAll(/'([^']*)'/g)].map((match) => match[1].replaceAll(BAKED, baked));
  assert.match(lines.at(-1), /^exec node \/usr\/local\/lib\/node_modules\/hyperframes\/bin\/hyperframes\.mjs "\$@"$/);
  return [...lines.slice(0, -1), 'printf %s "$HYPERFRAMES_FONT_CACHE_DIR"'].join("\n");
}
function cacheFor(env, baked) {
  return execFileSync("sh", ["-c", wrapper(baked)], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
}

test("its script keeps HyperFrames' font cache in HOME and links each folder the build made into it, whatever its name", (t) => {
  const home = mkdtempSync(join(tmpdir(), "media-home-"));
  const baked = mkdtempSync(join(tmpdir(), "media-baked-"));
  t.after(() => [home, baked].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  for (const name of ["local-compression-v1", "a-later-name"]) mkdirSync(join(baked, name));
  const cache = join(home, ".cache", "hyperframes", "fonts");
  assert.equal(cacheFor({ HOME: home }, baked), cache);
  const links = () => readdirSync(cache).sort().map((name) => [name, readlinkSync(join(cache, name))]);
  assert.deepEqual(links(), [["a-later-name", join(baked, "a-later-name")], ["local-compression-v1", join(baked, "local-compression-v1")]]);
  assert.equal(cacheFor({ HOME: home }, baked), cache, "a second run in the same HOME");
  assert.deepEqual(links().length, 2);
});

test("its script leaves a font cache the caller names alone", (t) => {
  const home = mkdtempSync(join(tmpdir(), "media-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const named = join(home, "mine");
  assert.equal(cacheFor({ HOME: home, HYPERFRAMES_FONT_CACHE_DIR: named }), named);
  assert.deepEqual(readdirSync(home), [], "nothing made in HOME");
});

test("the package ships it", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("media"), JSON.stringify(pkg.files));
});

// --- the release's media job (.github/workflows/release.yml) ---

/** The command that names the image's tag: the first 12 hex digits of the Dockerfile's sha256. */
const HASH_LINE = "sha256sum packages/computer/media/Dockerfile | cut -c1-12";

test("the release publishes it beside the box image, amd64, tagged by its Dockerfile's hash and the release, under the release's approval, and checks it public", async () => {
  const { parse } = await import("yaml");
  const workflow = parse(readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"));
  const { media: job, box } = workflow.jobs;
  assert.ok(job, "a media job");
  assert.equal(job.needs, "gate", "after the gate alone, so it asks for the npm-release approval with the publish job");
  assert.equal(job.if, box.if);
  assert.equal(job.environment, "npm-release", "nothing is published for a release nobody approved");
  assert.deepEqual(job.permissions, { contents: "read", packages: "write" });
  assert.equal(job.env.IMAGE, "ghcr.io/parcha-ai/agentrun-media");
  for (const step of job.steps.filter((step) => step.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} is pinned by commit`);
  const uses = (name) => (steps) => steps.find((step) => (step.uses ?? "").startsWith(`${name}@`));
  for (const name of ["actions/checkout", "actions/setup-node", "docker/setup-buildx-action", "docker/login-action", "docker/build-push-action"]) {
    assert.deepEqual(uses(name)(job.steps)?.uses, uses(name)(box.steps).uses, `${name} as the box job pins it`);
  }
  assert.deepEqual(uses("docker/setup-buildx-action")(job.steps).with, uses("docker/setup-buildx-action")(box.steps).with, "BuildKit by digest");
  // The tag is the one the Dockerfile's and the README's build lines give.
  const hash = job.steps.find((step) => step.id === "hash");
  assert.ok(hash.run.includes(`hash="$(${HASH_LINE})"`), hash.run);
  assert.ok(DOCKERFILE.includes(`tag=agentrun-media:$(${HASH_LINE})`), "the Dockerfile's build line");
  const readme = readFileSync(new URL("../../serve/README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(`tag=agentrun-media:$(${HASH_LINE})`), "the README's build line");
  const root = new URL("../../../", import.meta.url);
  assert.match(execFileSync("bash", ["-c", HASH_LINE], { cwd: root, encoding: "utf8" }).trim(), /^[0-9a-f]{12}$/);
  // Built once per Dockerfile, as a box recipe is, by the box job's own published check.
  const published = job.steps.find((step) => step.id === "published");
  assert.equal(published.run, box.steps.find((step) => step.id === "published").run);
  assert.equal(published.env.RECIPE, "${{ steps.hash.outputs.hash }}");
  const build = uses("docker/build-push-action")(job.steps);
  assert.equal(build.if, "steps.published.outputs.published != 'true'");
  assert.equal(build.with.context, "packages/computer/media");
  assert.equal(build.with.file, "packages/computer/media/Dockerfile");
  assert.equal(build.with.platforms, "linux/amd64");
  assert.equal(build.with.provenance, "mode=max");
  assert.equal(build.with.sbom, true);
  assert.equal(build.with.push, true);
  assert.equal(build.with["build-args"], undefined);
  assert.equal(build.with.secrets, undefined);
  assert.deepEqual(build.with.tags.trim().split("\n"), ["${{ env.IMAGE }}:${{ steps.hash.outputs.hash }}", "${{ env.IMAGE }}:${{ inputs.tag }}"]);
  assert.ok(!INSTRUCTIONS.some((line) => /^(COPY|ADD) /.test(line)), "it takes nothing from its context");
  assert.match(job.steps.find((step) => step.if === "steps.published.outputs.published == 'true'").run, /imagetools create --tag "\$IMAGE:\$RELEASE_TAG" "\$IMAGE:\$RECIPE"/, "a published Dockerfile is tagged with the release");
  // A stranger pulls it with no credentials: a private package stops the job, after the push, in words.
  const at = (pattern) => job.steps.findIndex((step) => pattern.test(step.run ?? step.uses ?? ""));
  const pub = job.steps[at(/ghcr-published\.mjs/)];
  assert.ok(at(/ghcr-published\.mjs/) > at(/^docker\/build-push-action@/) && at(/ghcr-published\.mjs/) > at(/imagetools create --tag/));
  assert.equal(pub.env.MEDIA_IMAGE, "${{ env.IMAGE }}:${{ steps.hash.outputs.hash }}");
  assert.match(pub.run, /^node scripts\/ghcr-published\.mjs "\$MEDIA_IMAGE" \|\| \{ echo "::error::[^\n]*; exit 1; \}$/m);
  const secrets = (JSON.stringify(job).match(/secrets\.\w+/g) ?? []).filter((name) => name !== "secrets.GITHUB_TOKEN");
  assert.deepEqual(secrets, [], "no secret beside this run's GITHUB_TOKEN, which pushes the image");
});
