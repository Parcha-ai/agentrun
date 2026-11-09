// A Docker sandbox on a fresh host, through the composer (workspace/computer-deps.ts computerDepsFrom): the run's image is
// the computer package's recipe (DOCKER_RECIPE), which no registry has, so it is BUILT here (`docker build -`, tagged
// agentrun-computer:<hash>) when Docker lacks it, never pulled; an image the owner names (AGENTRUN_DOCKER_IMAGE) is pulled.
// The real Docker provider (providerFor("docker")) runs over a fake docker first on PATH: the computer package's fake for
// containers, behind a host of our own that keeps the images (inspect, build, pull, and run's own pull of an image it
// lacks), as Docker does: the recipe's tag is in no registry, so a pull of it, or a run of it unbuilt, is refused.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { DOCKER_RECIPE, providerFor, recipeTag } from "@parcha/agentrun-computer";
import { fakeDocker } from "../../computer/test/fake-docker.mjs";
import { computerDepsFrom, localWorkspace } from "../dist/workspace/index.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const scratch = (name) => {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), name)));
  dirs.push(dir);
  return dir;
};
const RECIPE_TAG = recipeTag(DOCKER_RECIPE);

/** A host's images over the computer package's fake docker: a `docker` first on PATH that keeps which images the host has
 *  (none to begin with), answers `version`, `image inspect` (the labels), `build` (the tag and labels it is given) and
 *  `pull` (refused for the recipe's repository, which no registry has), and refuses a `run` of an image it lacks that no
 *  registry has, as Docker's own pull for run is refused. Every other call is the fake's. `calls()`: each call's argv. */
function dockerHost() {
  const fake = fakeDocker();
  const dir = scratch("agentrun-docker-host-");
  const images = join(dir, "images.json");
  const log = join(dir, "calls.jsonl");
  writeFileSync(images, "{}");
  writeFileSync(log, "");
  const program = join(dir, "docker");
  writeFileSync(program, `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const load = () => JSON.parse(readFileSync(${JSON.stringify(images)}, "utf8"));
const save = (all) => writeFileSync(${JSON.stringify(images)}, JSON.stringify(all));
const unpullable = (image) => image.startsWith("agentrun-computer:");
const denied = (image) => { process.stderr.write("Error response from daemon: pull access denied for " + image.split(":")[0] + ", repository does not exist or may require 'docker login'\\n"); process.exit(1); };
if (args[0] === "version") { process.stdout.write("amd64\\n"); process.exit(0); }
if (args[0] === "image" && args[1] === "inspect") {
  const all = load(); const image = args.at(-1);
  if (!all[image]) { process.stderr.write("Error response from daemon: No such image: " + image + "\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(all[image].labels) + "\\n"); process.exit(0);
}
if (args[0] === "build") {
  readFileSync(0);
  const tag = args[args.indexOf("--tag") + 1];
  const labels = Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === "--label" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : [])));
  const all = load(); all[tag] = { labels }; save(all);
  process.stdout.write("sha256:" + "b".repeat(64) + "\\n"); process.exit(0);
}
if (args[0] === "pull") {
  const image = args.at(-1);
  if (unpullable(image)) denied(image);
  const all = load(); all[image] = { labels: {} }; save(all);
  process.stdout.write(image + "\\n"); process.exit(0);
}
if (args[0] === "run" && !args.includes("node")) {
  const all = load();
  const image = args.find((arg) => arg.startsWith("agentrun-computer:") || arg.includes("ubuntu:"));
  if (image !== undefined && !all[image]) {
    if (unpullable(image)) { process.stderr.write("Unable to find image '" + image + "' locally\\n"); denied(image); }
    all[image] = { labels: {}, pulledByRun: true }; save(all);
  }
}
const ran = spawnSync(${JSON.stringify(fake.program)}, args, { stdio: "inherit" });
process.exit(ran.status ?? 1);
`, { mode: 0o755 });
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { fake, dir, program, calls, images: () => JSON.parse(readFileSync(images, "utf8")) };
}

/** A Mode 1 Docker sandbox through the composer on a host made by dockerHost, with `env` the server's environment. */
async function dockerSandbox(t, env = {}) {
  const host = dockerHost();
  const path = process.env.PATH;
  process.env.PATH = `${host.dir}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const root = join(scratch("agentrun-docker-run-"), "work");
  mkdirSync(root);
  const store = {
    agents: { revision: async () => undefined },
    sealedKeys: { get: async () => undefined, put: async () => {}, remove: async () => {}, all: async () => [] },
    computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
  };
  const sealKey = randomBytes(32);
  // The production builder, told only where the fake's daemon file and cache are; docker is the one first on PATH.
  const load = (id, options) => providerFor(id, { ...options, daemonPath: host.fake.daemonPath, daemonCache: host.fake.cache });
  const { computerForClaim, computerDeps } = computerDepsFrom({ env, store, sealKey, load });
  const claim = () => computerForClaim({ runId: "run-1", epoch: 1, computer: { kind: "sandbox", provider: "docker" } }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(root), sealKey });
  return { host, claim };
}

const ran = (calls) => calls.filter((args) => args[0] === "run" && !args.includes("node"));
const imageOfRun = (args) => args.find((arg) => arg.startsWith("agentrun-computer:") || arg.includes("ubuntu:"));

test("a fresh host BUILDS the recipe's image for a Docker sandbox and starts it: the recipe's tag is never pulled", async (t) => {
  const { host, claim } = await dockerSandbox(t);
  assert.deepEqual(host.images(), {}, "a fresh host: no image yet");
  const answer = await claim();
  assert.equal(answer.computer?.kind, "sandbox", "the sandbox started");
  const calls = host.calls();
  const builds = calls.filter((args) => args[0] === "build");
  assert.equal(builds.length, 1, `built once: ${JSON.stringify(calls.map((args) => args.slice(0, 2)))}`);
  assert.equal(builds[0][builds[0].indexOf("--tag") + 1], RECIPE_TAG, "tagged as the recipe's");
  assert.deepEqual(calls.filter((args) => args[0] === "pull" && args.at(-1).startsWith("agentrun-computer:")), [], "the recipe's tag is never pulled");
  assert.equal(imageOfRun(ran(calls)[0]), RECIPE_TAG, "the computer runs the image just built");
  assert.ok(!host.images()[RECIPE_TAG].pulledByRun, "docker run found it built, and pulled nothing");
  await answer.release();
});

test("a second sandbox on the same host finds the recipe's image built: no second build", async (t) => {
  const { host, claim } = await dockerSandbox(t);
  await (await claim()).release();
  await (await claim()).release();
  assert.equal(host.calls().filter((args) => args[0] === "build").length, 1, "built once for both");
});

test("an image the owner names (AGENTRUN_DOCKER_IMAGE) is pulled, never built", async (t) => {
  const named = "ubuntu:22.04";
  const { host, claim } = await dockerSandbox(t, { AGENTRUN_DOCKER_IMAGE: named });
  const answer = await claim();
  assert.equal(answer.computer?.kind, "sandbox");
  const calls = host.calls();
  assert.deepEqual(calls.filter((args) => args[0] === "build"), [], "nothing built");
  assert.ok(host.images()[named], `the named image is on the host: ${JSON.stringify(host.images())}`);
  assert.equal(imageOfRun(ran(calls)[0]), named, "the computer runs the named image");
  await answer.release();
});
