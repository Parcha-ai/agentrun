// The media box image (media/Dockerfile), read as text: no network, no docker. It is the Docker box's default image and
// more, for an agent that renders video: the same base digest as DOCKER_RECIPE, every program the default recipe installs
// (but Debian's nodejs and npm, which Node's own tarball replaces), Node 22 or later from nodejs.org pinned by sha256 for
// each architecture, Chromium (`chrome` on PATH), FFmpeg and FFprobe, fonts for titles, and the HyperFrames CLI at an
// exact version. It names no key and no second image picker: an operator builds it and names its tag in
// AGENTRUN_DOCKER_IMAGE. The package ships it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DOCKER_BASE, DOCKER_RECIPE } from "../dist/index.js";

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
// of its fonts once, at build, by HyperFrames' own fontToDataUri (its key and its bytes, never a copy of its scheme).
test("its system fonts are compressed for HyperFrames at build, by HyperFrames itself, from the image's own fonts", () => {
  const fill = INSTRUCTIONS.findIndex((line) => line.startsWith("RUN ") && line.includes("fontToDataUri") && line.includes(`${BAKED}/local-compression-v1`));
  assert.ok(fill > 0, "a RUN fills the cache with HyperFrames' fontToDataUri");
  assert.ok(fill > INSTRUCTIONS.findIndex((line) => /npm install --global .*hyperframes@/.test(line)), "after HyperFrames is installed");
  assert.match(INSTRUCTIONS[fill], /\/usr\/share\/fonts/, "from the image's own fonts");
});

// The `hyperframes` script, as the Dockerfile writes it, run by sh with its last line (exec node) swapped for one that
// says the font cache it hands HyperFrames. That cache stays in HOME, writable, as HyperFrames' Google Fonts downloads
// need it to be (a read-only one makes HyperFrames warn "unwritable ... chmod 755" on every render), and its compression
// folder is a link to the one compressed at build. A cache the caller names is left alone.
const BAKED = "/usr/local/share/hyperframes/fonts";
function wrapper() {
  const block = DOCKERFILE.slice(DOCKERFILE.indexOf("printf '%s\\n'"), DOCKERFILE.indexOf("> /usr/local/bin/hyperframes"));
  const lines = [...block.slice("printf '%s\\n'".length).matchAll(/'([^']*)'/g)].map((match) => match[1]);
  assert.match(lines.at(-1), /^exec node \/usr\/local\/lib\/node_modules\/hyperframes\/bin\/hyperframes\.mjs "\$@"$/);
  return [...lines.slice(0, -1), 'printf %s "$HYPERFRAMES_FONT_CACHE_DIR"'].join("\n");
}
function cacheFor(env) {
  return execFileSync("sh", ["-c", wrapper()], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
}

test("its script keeps HyperFrames' font cache in HOME and links its compression folder to the one made at build", (t) => {
  const home = mkdtempSync(join(tmpdir(), "media-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cache = join(home, ".cache", "hyperframes", "fonts");
  assert.equal(cacheFor({ HOME: home }), cache);
  assert.equal(readlinkSync(join(cache, "local-compression-v1")), `${BAKED}/local-compression-v1`);
  assert.equal(cacheFor({ HOME: home }), cache, "a second run in the same HOME");
  assert.equal(readlinkSync(join(cache, "local-compression-v1")), `${BAKED}/local-compression-v1`);
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
