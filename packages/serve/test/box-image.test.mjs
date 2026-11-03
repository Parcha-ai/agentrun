// The Docker box's image at the server's start (box-image.ts), with a fake `docker` first on PATH
// (fixtures/fake-docker.mjs; no daemon is reached, nothing is pulled or built anywhere). The default image is the server's
// own: built from its recipe on first use, labelled with the recipe's hash, built again only when the recipe changes.
// AGENTRUN_DOCKER_IMAGE names another, pulled when Docker has none. While either comes, capabilities say docker is
// preparing; a sandbox run whose first box comes then waits for it with one timeline row, and its box is made once the
// image is in. A build or pull that fails, or takes too long, makes docker unavailable with a reason that holds none of
// Docker's output, refuses the next sandbox run naming it, and fails the call of a run that was waiting.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { awaitImage, BOX_RECIPE, DEFAULT_DOCKER_IMAGE, dockerImage, IMAGE_STATE_FILE, RECIPE_HASH, RECIPE_LABEL, STALE_AFTER_MS } from "../dist/box-image.js";
import { follow, scratch, serve, withEnv } from "./support.mjs";
import { startServe } from "../dist/index.js";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const IMAGE = "debian:bookworm-slim";
const SANDBOX = { mode: "sandbox", box: "docker" };
const PULLING = `Preparing the box image: pulling ${IMAGE}…`;
const BUILDING = "Preparing the box image: building it (python, git, curl, node, rg)…";
/** Docker's own words for a refused pull, with a marker no reason may carry. */
const DENIED = `Error response from daemon: pull access denied for nosuch/box, repository does not exist or may require 'docker login': denied: requested access to the resource is denied RAW-DOCKER-STDERR`;

/** A fake docker first on PATH, docker listed in AGENTRUN_BOXES (and `vars` set), and the state files `marks` names made
 *  (`no-image`, `pull-hold`, `pull-fail`, `build-hold`, `build-fail`). `release()` lets a held pull or build go on;
 *  `keep(name, labels)` gives Docker an image. */
async function fakeDocker(t, marks = {}, vars = {}) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  for (const [name, text] of Object.entries(marks)) await writeFile(join(state, name), text);
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, AGENTRUN_BOXES: "docker", ...vars }, ["AGENTRUN_DOCKER_IMAGE"]);
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
  const calls = () => (existsSync(join(state, "argv.jsonl")) ? readFileSync(join(state, "argv.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  const made = () => (existsSync(join(state, "made.jsonl")) ? readFileSync(join(state, "made.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return {
    state, calls, made,
    pulls: () => calls().filter((args) => args[0] === "pull"),
    builds: () => (existsSync(join(state, "builds.jsonl")) ? readFileSync(join(state, "builds.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    runs: () => calls().filter((args) => args[0] === "run"),
    release: () => Promise.all(["pull-hold", "build-hold"].map((mark) => rm(join(state, mark), { force: true }))),
    keep: async (name, labels) => (await mkdir(join(state, "images"), { recursive: true }), writeFile(join(state, "images", `${encodeURIComponent(name)}.json`), JSON.stringify({ labels }))),
  };
}

const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const recordOf = (data) => JSON.parse(readFileSync(join(data, IMAGE_STATE_FILE), "utf8"));
const dockerOffer = async (api) => (await api("GET", "/capabilities")).body.places.boxes.find((box) => box.id === "docker");
/** The run's timeline as it is now, every page read. */
async function rowsOf(api, runId) {
  const rows = new Map();
  for (let after = 0; ; ) {
    const page = (await api("GET", `/runs/${runId}/timeline?after=${after}`)).body;
    for (const row of page.rows) rows.set(row.id, row);
    after = page.next_after;
    if (!page.has_more) return [...rows.values()].sort((a, b) => a.seq - b.seq);
  }
}
function answers(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    db.close();
  }
}
const OVERRIDE = { AGENTRUN_DOCKER_IMAGE: IMAGE };
/** What a build that cannot reach the network says, with a marker no reason may carry. */
const OFFLINE = "ERROR: failed to solve: python:3.12-slim: failed to resolve source metadata for docker.io/library/python:3.12-slim: failed to do request: Head \"https://registry-1.docker.io/v2/library/python/manifests/3.12-slim\": dial tcp: lookup registry-1.docker.io: no such host RAW-DOCKER-STDERR";
/** What a build whose base the registry refuses says. */
const NO_BASE = "ERROR: failed to solve: python:3.12-slim: failed to resolve source metadata for docker.io/library/python:3.12-slim: pull access denied, repository does not exist or may require authorization RAW-DOCKER-STDERR";
const NEXT = "set AGENTRUN_DOCKER_IMAGE to an image this machine has, or restart the server to build it again";
const INSPECT = ["image", "inspect", "--format", "{{json .Config.Labels}}"];

async function boxedRun(api, plan) {
  const made = await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["bash", "write", "read"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}
/** The server's log lines, as `startServe({ log })` gives them. */
const logged = () => {
  const lines = [];
  return { lines, log: (line) => void lines.push(line), of: (event) => lines.filter((line) => line.includes(` event=${event} `)) };
};

test("the default image is built on first use, once, from a private context directory holding the recipe alone, removed after; tagged with the recipe's hash and labelled with it; present with that hash, it is ready with no build", async (t) => {
  const docker = await fakeDocker(t, { "build-hold": "" });
  const data = await scratch(t);
  assert.equal(DEFAULT_DOCKER_IMAGE, `agentrun-box:${RECIPE_HASH.slice(0, 12)}`);
  const changes = [];
  const before = Date.now();
  const image = await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE, { onChange: (state) => changes.push(state) });
  assert.deepEqual(image.state(), { state: "preparing", reason: "building the box image (python, git, curl, node, rg)" }, "the start does not wait for the build");
  const preparing = recordOf(data);
  assert.deepEqual([preparing.state, preparing.row], ["preparing", BUILDING]);
  assert.ok(preparing.until >= before + 10 * 60_000 && preparing.until <= Date.now() + 10 * 60_000, "the record holds the build's deadline");
  await until(() => docker.builds().length === 1, "the build");
  await docker.release();
  assert.deepEqual(await image.settled, { state: "ready" });
  assert.deepEqual(changes, [{ state: "ready" }], "told once, when it settled");
  const [build] = docker.builds();
  assert.equal(docker.builds().length, 1, "one build");
  assert.deepEqual({ ...build, context: undefined }, { tag: DEFAULT_DOCKER_IMAGE, labels: { [RECIPE_LABEL]: RECIPE_HASH }, context: undefined, mode: "700", files: ["Dockerfile"], recipe: BOX_RECIPE }, "of the recipe alone, in a 0700 directory, labelled with its hash");
  assert.ok(build.context.startsWith(`${process.env.TMPDIR ?? tmpdir()}/`) || build.context.startsWith(`${tmpdir()}/`), `under TMPDIR: ${build.context}`);
  assert.equal(existsSync(build.context), false, "the context directory is gone after the build");
  assert.match(BOX_RECIPE, /^FROM python:3\.12-slim@sha256:[0-9a-f]{64}\n/, "the base pinned by its digest");
  assert.equal([...BOX_RECIPE.matchAll(/^FROM /gm)].length, 1, "one FROM, python:3.12-slim");
  assert.match(BOX_RECIPE, /apt-get install -y --no-install-recommends git curl ca-certificates nodejs ripgrep \\\n && rm -rf \/var\/lib\/apt\/lists\/\*\n$/, "node and rg from apt, the lists cleaned after");
  assert.deepEqual(docker.calls().find((args) => args[0] === "build"), ["build", "--quiet", "--label", `${RECIPE_LABEL}=${RECIPE_HASH}`, "--tag", DEFAULT_DOCKER_IMAGE, build.context], "the context directory is the build's last argument, never stdin");
  assert.deepEqual(docker.pulls(), [], "nothing is pulled by hand: the build pulls its base");
  // The next start finds it, with this recipe's hash: no build.
  const again = await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE);
  assert.deepEqual(again.state(), { state: "ready" });
  assert.equal(docker.builds().length, 1, "no second build");
  assert.deepEqual(recordOf(data), { image: DEFAULT_DOCKER_IMAGE, state: "ready" });
});

test("a recipe change builds again: another recipe's image, under its own tag or under this one with another hash, is not this recipe's", async (t) => {
  const docker = await fakeDocker(t);
  const data = await scratch(t);
  await docker.keep("agentrun-box:0123456789ab", { [RECIPE_LABEL]: "0123456789ab".padEnd(64, "0") });
  assert.deepEqual(await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE)).settled, { state: "ready" });
  assert.equal(docker.builds().length, 1, "an older recipe's image leaves this one to build");
  await docker.keep(DEFAULT_DOCKER_IMAGE, { [RECIPE_LABEL]: "f".repeat(64) });
  assert.deepEqual(await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE)).settled, { state: "ready" });
  assert.equal(docker.builds().length, 2, "this tag with another hash is built again");
  await docker.keep(DEFAULT_DOCKER_IMAGE, null);
  await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE)).settled;
  assert.equal(docker.builds().length, 3, "and so is one with no label at all");
});

test("a build that fails, or takes too long, makes the box unavailable with a reason that names the cause and the next step, and holds none of Docker's output", async (t) => {
  const docker = await fakeDocker(t, { "build-fail": OFFLINE });
  const data = await scratch(t);
  const failed = await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE)).settled;
  assert.deepEqual(failed, { state: "unavailable", reason: `the build of the box image could not reach the network (it pulls python:3.12-slim and installs git, curl, nodejs and ripgrep with apt): ${NEXT}` });
  assert.ok(!failed.reason.includes("RAW-DOCKER-STDERR"));
  assert.deepEqual(recordOf(data), { image: DEFAULT_DOCKER_IMAGE, state: "unavailable", reason: failed.reason });
  await writeFile(join(docker.state, "build-fail"), NO_BASE);
  assert.equal((await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE)).settled).reason, `the build of the box image could not pull its base, python:3.12-slim: ${NEXT}`);
  await writeFile(join(docker.state, "build-fail"), "failed to copy files: write /var/lib/docker/x: no space left on device RAW-DOCKER-STDERR");
  assert.equal((await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE)).settled).reason, "the build of the box image ran out of disk space: free some, then restart the server");
  await writeFile(join(docker.state, "build-fail"), "E: Unable to locate package git RAW-DOCKER-STDERR");
  assert.match((await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE)).settled).reason, /^apt could not install what the box image needs \(git, curl, nodejs, ripgrep\): /);
  await writeFile(join(docker.state, "build-fail"), "Err:1 http://deb.debian.org/debian bookworm InRelease Temporary failure resolving 'deb.debian.org' RAW-DOCKER-STDERR");
  assert.match((await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE)).settled).reason, /^the build of the box image could not reach the network \(it pulls python:3\.12-slim and installs git, curl, nodejs and ripgrep with apt\): /);
  await rm(join(docker.state, "build-fail"));
  await writeFile(join(docker.state, "build-hold"), "");
  const started = Date.now();
  const late = await (await dockerImage(process.env, data, DEFAULT_DOCKER_IMAGE, { buildTimeoutMs: 1_000 })).settled;
  assert.ok(Date.now() - started < 10_000, "the bound ends the build");
  assert.deepEqual(late, { state: "unavailable", reason: `the build of the box image did not finish within 1 s: ${NEXT}` });
  for (const { context } of docker.builds()) assert.equal(existsSync(context), false, `a failed or stopped build leaves no context directory: ${context}`);
});

test("another image named in AGENTRUN_DOCKER_IMAGE: one Docker has is ready at once, with one inspect and nothing pulled or built", async (t) => {
  const docker = await fakeDocker(t);
  const data = await scratch(t);
  const image = await dockerImage(process.env, data, IMAGE);
  assert.deepEqual(image.state(), { state: "ready" });
  assert.deepEqual(await image.settled, { state: "ready" });
  assert.deepEqual(docker.calls(), [[...INSPECT, IMAGE]]);
  assert.deepEqual(recordOf(data), { image: IMAGE, state: "ready" });
});

test("another image Docker has not is pulled once in the background, never built: preparing, with its deadline and row in the record, then ready", async (t) => {
  const docker = await fakeDocker(t, { "no-image": "", "pull-hold": "" });
  const data = await scratch(t);
  const changes = [];
  const before = Date.now();
  const image = await dockerImage(process.env, data, IMAGE, { onChange: (state, ms) => changes.push([state, ms]) });
  assert.deepEqual(image.state(), { state: "preparing", reason: `pulling ${IMAGE}` }, "the start does not wait for the pull");
  const preparing = recordOf(data);
  assert.deepEqual([preparing.state, preparing.row], ["preparing", PULLING]);
  assert.ok(preparing.until >= before + 10 * 60_000 && preparing.until <= Date.now() + 10 * 60_000, "the record holds the pull's deadline");
  await until(() => docker.pulls().length === 1, "the pull");
  await docker.release();
  assert.deepEqual(await image.settled, { state: "ready" });
  assert.deepEqual(recordOf(data), { image: IMAGE, state: "ready" });
  assert.deepEqual(changes.map(([state]) => state), [{ state: "ready" }], "told once, when it settled");
  assert.deepEqual(docker.pulls(), [["pull", "--quiet", IMAGE]], "one pull, of the image");
  assert.deepEqual(docker.builds(), [], "never built");
});

test("a docker that is Podman, saying `image not known`, has the image pulled (or built) as Docker's would", async (t) => {
  const docker = await fakeDocker(t, { "no-image": "", "podman-words": "" });
  const image = await dockerImage(process.env, await scratch(t), IMAGE);
  assert.equal(image.state().state, "preparing");
  assert.deepEqual(await image.settled, { state: "ready" });
  assert.equal(docker.pulls().length, 1);
  assert.deepEqual(await (await dockerImage(process.env, await scratch(t), DEFAULT_DOCKER_IMAGE)).settled, { state: "ready" });
  assert.equal(docker.builds().length, 1);
});

test("a final state that cannot be written removes the record, so no run waits on a stale `preparing`, and says so", async (t) => {
  const docker = await fakeDocker(t, { "no-image": "", "pull-hold": "" });
  const data = await scratch(t);
  const warned = [];
  const image = await dockerImage(process.env, data, IMAGE, { warn: (message) => void warned.push(message) });
  assert.equal(recordOf(data).state, "preparing");
  // The record is written whole or not at all, through a file beside it: with a directory there, the next write fails.
  await mkdir(join(data, `${IMAGE_STATE_FILE}.partial`));
  await docker.release();
  assert.deepEqual(await image.settled, { state: "ready" }, "the server's own state is right");
  assert.equal(existsSync(join(data, IMAGE_STATE_FILE)), false, "the stale record is gone: a waiting run makes its box as before");
  assert.equal(warned.length, 1, JSON.stringify(warned));
  assert.match(warned[0], /^the record of the box image's state could not be written \(EISDIR\), so it was removed: runs make their boxes without waiting on it$/);
});

test("a pull that fails makes the box unavailable with a reason that holds none of Docker's output", async (t) => {
  const denied = await fakeDocker(t, { "no-image": "", "pull-fail": DENIED });
  const data = await scratch(t);
  const failed = await (await dockerImage(process.env, data, IMAGE)).settled;
  assert.equal(failed.state, "unavailable");
  assert.match(failed.reason, /^the registry refused the pull of debian:bookworm-slim \(no such repository, or it needs a docker login\): run `docker pull debian:bookworm-slim` on this machine to see why, then restart the server$/);
  assert.ok(!failed.reason.includes("RAW-DOCKER-STDERR"), failed.reason);
  assert.deepEqual(recordOf(data), { image: IMAGE, state: "unavailable", reason: failed.reason });
  assert.equal(denied.pulls().length, 1);
});

test("a pull past its bound is stopped, and the box is unavailable, saying how to pull it by hand", async (t) => {
  const held = await fakeDocker(t, { "no-image": "", "pull-hold": "" });
  const data = await scratch(t);
  const slow = await dockerImage(process.env, data, IMAGE, { pullTimeoutMs: 1_000 });
  const started = Date.now();
  const late = await slow.settled;
  assert.ok(Date.now() - started < 10_000, "the bound ends the pull");
  assert.deepEqual(late, { state: "unavailable", reason: "the pull of debian:bookworm-slim did not finish within 1 s: run `docker pull debian:bookworm-slim` on this machine, then restart the server" });
  assert.equal(held.pulls().length, 1);
});

test("a run's first box waits on the record: at once when it is ready, missing or of another image; once noted, with the record's row, while it comes; with the reason when it failed; not past a dead server's deadline; not past a cancel", async (t) => {
  const data = await scratch(t);
  const notes = [];
  const note = (summary) => void notes.push(summary);
  const put = (record) => writeFile(join(data, IMAGE_STATE_FILE), JSON.stringify(record));
  await awaitImage(data, IMAGE, BACKGROUND_CONTEXT, note);
  await put({ image: IMAGE, state: "ready" });
  await awaitImage(data, IMAGE, BACKGROUND_CONTEXT, note);
  await put({ image: "other:1", state: "preparing", reason: "pulling other:1", until: Date.now() + 60_000, row: "other" });
  await awaitImage(data, IMAGE, BACKGROUND_CONTEXT, note);
  assert.deepEqual(notes, [], "nothing to wait for");

  await put({ image: IMAGE, state: "preparing", reason: `pulling ${IMAGE}`, until: Date.now() + 60_000, row: PULLING });
  let done = false;
  const waiting = awaitImage(data, IMAGE, BACKGROUND_CONTEXT, note).then(() => (done = true));
  await until(() => notes.length === 1, "the note");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(done, false, "it waits while the image comes");
  await put({ image: IMAGE, state: "ready" });
  await waiting;
  assert.deepEqual(notes, [PULLING], "one note, the record's row");
  await put({ image: IMAGE, state: "unavailable", reason: "the registry could not be reached to pull it" });
  await assert.rejects(awaitImage(data, IMAGE, BACKGROUND_CONTEXT, note), /its image debian:bookworm-slim is not ready: the registry could not be reached to pull it/);
  await put({ image: IMAGE, state: "preparing", reason: `pulling ${IMAGE}`, until: Date.now() - STALE_AFTER_MS - 1 });
  await awaitImage(data, IMAGE, BACKGROUND_CONTEXT, note);
  await put({ image: IMAGE, state: "preparing", reason: `pulling ${IMAGE}`, until: Date.now() + 60_000 });
  const controller = new AbortController();
  const cancelled = awaitImage(data, IMAGE, withAbortSignal(controller.signal, BACKGROUND_CONTEXT), note);
  setTimeout(() => controller.abort(new Error("cancelled")), 100);
  await assert.rejects(cancelled, /cancelled/);
});

/** A sandbox run that starts while the image comes (`way`: built or pulled) shows one row and waits, its box made once
 *  the image is in; then docker is ready and the next run makes its box at once. */
async function waitsForTheImage(t, way) {
  const built = way === "build";
  const docker = await fakeDocker(t, built ? { "build-hold": "" } : { "no-image": "", "pull-hold": "" }, built ? {} : OVERRIDE);
  const [image, row, reason] = built ? [DEFAULT_DOCKER_IMAGE, BUILDING, "building the box image (python, git, curl, node, rg)"] : [IMAGE, PULLING, `pulling ${IMAGE}`];
  const printed = logged();
  const { api, data } = await serve(t, { faux: PROBE, log: printed.log });
  assert.deepEqual(await dockerOffer(api), { id: "docker", available: true, state: "preparing", reason });
  assert.equal(printed.of("box_image").length, 1);
  assert.ok(printed.of("box_image")[0].includes(`image=${image} state=preparing reason="${reason}"`), printed.of("box_image")[0]);
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: "printf boxed > out.txt" } }, { tool: "read", args: { path: "out.txt" } }]);
  await until(async () => (await rowsOf(api, runId)).some((r) => r.summary === row), "the preparing row");
  assert.equal((await rowsOf(api, runId)).find((r) => r.summary === row).kind, "phase");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(docker.runs(), [], `no box is made while the image is ${built ? "built" : "pulled"}`);
  assert.ok(!["failed", "completed", "cancelled"].includes((await api("GET", `/runs/${runId}`)).body.status), "the run waits, it does not end");
  await docker.release();
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(answers(data, runId).map((a) => [a.tool, a.error]), [["bash", false], ["read", false]]);
  assert.equal(answers(data, runId)[1].text, "boxed");
  const rows = await rowsOf(api, runId);
  assert.equal(rows.filter((r) => r.summary?.startsWith("Preparing the box image")).length, 1, "one row, however long it takes");
  assert.ok(rows.findIndex((r) => r.summary === row) < rows.findIndex((r) => r.kind === "tool_result"), "the row comes before the call's result");
  const order = docker.calls().map((args) => args[0]);
  assert.ok(order.indexOf(way) >= 0 && order.indexOf(way) < order.indexOf("run"), `the box is made after the ${way}`);
  assert.deepEqual(docker.made().map((box) => [box.image, box.pulledInRun]), [[image, false]], "one box, from the image, and no `docker run` pulled it");
  assert.deepEqual([docker.builds().length, docker.pulls().length], built ? [1, 0] : [0, 1], built ? "built once, never pulled by hand" : "pulled once, never built");
  await until(async () => (await dockerOffer(api)).state === "ready", "docker ready in capabilities");
  assert.deepEqual(await dockerOffer(api), { id: "docker", available: true, state: "ready" });
  assert.ok(new RegExp(`image=${image.replace(/[.:]/g, "\\$&")} state=ready ms=\\d+`).test(printed.of("box_image").at(-1)), printed.of("box_image").at(-1));
  // The next run makes its box at once: no row.
  const again = (await api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: [{ tool: "bash", args: { command: "true" } }] }) } })).body.run_id;
  await follow(api, again, ["completed"], { deadlineMs: 60_000 });
  assert.equal((await rowsOf(api, again)).filter((r) => r.summary?.startsWith("Preparing the box image")).length, 0);
}

test("demo through the API: the default image is built at the first start, capabilities say preparing; a sandbox run that starts during the build shows one row and waits, its box made from the built image once it is in; then docker is ready", { timeout: 120_000 }, (t) => waitsForTheImage(t, "build"));

test("demo through the API, AGENTRUN_DOCKER_IMAGE: the image it names is pulled, never built; a run during the pull shows one row and waits the same way", { timeout: 120_000 }, (t) => waitsForTheImage(t, "pull"));

test("a build that fails: the run waiting on it fails its call with the reason, docker is unavailable in capabilities, and a new sandbox run is 409 naming it", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, { "build-hold": "", "build-fail": OFFLINE });
  const printed = logged();
  const { api, data } = await serve(t, { faux: PROBE, log: printed.log });
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: "printf boxed > out.txt" } }]);
  await until(async () => (await rowsOf(api, runId)).some((row) => row.summary === BUILDING), "the preparing row");
  await docker.release();
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const [said] = answers(data, runId);
  assert.equal(said.error, true);
  assert.ok(said.text.includes(`the run's box could not be made: its image ${DEFAULT_DOCKER_IMAGE} is not ready: the build of the box image could not reach the network`), said.text);
  assert.ok(!said.text.includes("RAW-DOCKER-STDERR"), said.text);
  assert.deepEqual(docker.runs(), [], "no box was made");
  await until(async () => (await dockerOffer(api)).state === "unavailable", "docker unavailable in capabilities");
  const offer = await dockerOffer(api);
  assert.equal(offer.available, false);
  assert.match(offer.reason, /^the build of the box image could not reach the network/);
  assert.match(printed.of("box_image").at(-1), /state=unavailable ms=\d+ reason="the build of the box image could not reach the network/);
  const refused = await api("POST", "/agents/boxed/runs", { input: { content: "hi" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.equal(refused.body.error.details.box, "docker");
  assert.match(refused.body.error.message, /the build of the box image could not reach the network/);
});

test("the server's close waits for the image's last record to be saved before it lets the data directory go, so a server started after it keeps its own record", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, { "no-image": "", "pull-hold": "" }, OVERRIDE);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  assert.equal(recordOf(data).state, "preparing");
  // The last save of the record goes through a file beside it: a FIFO there holds it, open, until something reads it.
  const held = join(data, `${IMAGE_STATE_FILE}.partial`);
  assert.equal(spawnSync("mkfifo", [held]).status, 0, "mkfifo");
  await docker.release();
  // The save is held once a thread of this process waits to open the FIFO (Linux names that wait `wait_for_partner`).
  const saving = () => readdirSync("/proc/self/task").some((task) => {
    try {
      return readFileSync(`/proc/self/task/${task}/wchan`, "utf8").includes("wait_for_partner");
    } catch {
      return false;
    }
  });
  await until(saving, "the last save, held");
  const closing = first.close();
  const pendingAfter = (promise, ms) => Promise.race([promise.then(() => false, () => false), new Promise((resolve) => setTimeout(() => resolve(true), ms))]);
  let waited;
  try {
    waited = await pendingAfter(closing, 1_000);
  } finally {
    // Let the save land, whatever the close did, so nothing is left blocked on the FIFO.
    await new Promise((resolve, reject) => createReadStream(held).on("data", () => undefined).on("end", resolve).on("error", reject));
  }
  assert.equal(waited, true, "the close waits while the image's last record is being saved");
  await closing;
  // A server started now, with another image Docker has, keeps its own record: nothing of the first lands after it.
  await rm(join(docker.state, "no-image"));
  withEnv(t, { AGENTRUN_DOCKER_IMAGE: "other:2" });
  const second = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  t.after(() => second.close());
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(recordOf(data), { image: "other:2", state: "ready" });
});

test("with no Docker box (none listed, or the tests' faux box), no image is asked for, and a record an earlier start left is removed", async (t) => {
  const docker = await fakeDocker(t);
  withEnv(t, {}, ["AGENTRUN_BOXES"]);
  const dir = await scratch(t);
  const data = join(dir, "agents");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, IMAGE_STATE_FILE), JSON.stringify({ image: IMAGE, state: "preparing", until: Date.now() + 60_000 }));
  const { api } = await serve(t, { data });
  const offer = await dockerOffer(api);
  assert.deepEqual([offer.available, offer.state, typeof offer.reason], [false, "unavailable", "string"]);
  assert.equal(existsSync(join(data, IMAGE_STATE_FILE)), false, "the stale record is gone");
  assert.deepEqual(docker.calls(), []);
});
