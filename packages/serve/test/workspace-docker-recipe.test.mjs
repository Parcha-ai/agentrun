// A Docker sandbox on a fresh host, through the composer (workspace/computer-deps.ts computerDepsFrom): the run's image is
// the computer package's recipe (DOCKER_RECIPE), which no registry has, so it is BUILT here (`docker build -`, tagged
// agentrun-computer:<hash>) when Docker lacks it, never pulled; an image the owner names (AGENTRUN_DOCKER_IMAGE) is pulled.
// The real Docker provider (providerFor("docker")) runs over a host that keeps its images (docker-host-fake.mjs, first on
// PATH, over the computer package's fake docker), as Docker does: the recipe's tag is in no registry, so a pull of it, or a
// run of it unbuilt, is refused.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DOCKER_RECIPE, providerFor, recipeTag } from "@parcha/agentrun-computer";
import { computerDepsFrom, localWorkspace } from "../dist/workspace/index.js";
import { dockerHost } from "./docker-host-fake.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const RECIPE_TAG = recipeTag(DOCKER_RECIPE);

/** A Mode 1 Docker sandbox through the composer on a fresh host (dockerHost), with `env` the server's environment. */
async function dockerSandbox(t, env = {}) {
  const host = dockerHost();
  const path = process.env.PATH;
  process.env.PATH = `${host.dir}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-docker-run-")));
  dirs.push(dir);
  const root = join(dir, "work");
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
