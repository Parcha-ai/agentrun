// A run whose agent needs programs in its sandbox (computer.needs), through the runner, its store and the spec builder pi
// really uses (adapter-run-spec.ts): the claim starts the box, asks it for each program (one `sh`, the names as its
// arguments, never text of its script), and only then does anything of the run reach a model. A box that lacks one ends
// the run failed in words naming what is missing and how to give a Docker box an image that has it (AGENTRUN_DOCKER_IMAGE,
// the media image's build), served as run_failed as every claim's refusal of its computer is; the model is never asked,
// and the box is let go. A box that has them
// runs as any other. A box that cannot be asked fails the same way, never passes. An agent with no needs asks nothing.
// The sandbox is a loopback stand-in for Docker's over the run's folder, whose exec answers `command -v` from the
// programs the test gives it; the model is a script. The check searches the folders the agent's shell searches (its fixed
// PATH, hands.ts shellEnv), never the image's own PATH, so a program the shell can't find is missing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { computerForClaim, shellEnv } = await import("../dist/workspace/index.js");
const { viewOverStore } = await import("../dist/store-view.js");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
const MEDIA = ["chrome", "ffmpeg", "ffprobe", "hyperframes"];
after(closeOpenSessions);

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The `sh` a stand-in box runs for the check: the names after `sh -c <script> sh`. */
const checked = (argv) => (argv[0] === "sh" && argv[1] === "-c" && argv[3] === "sh" ? argv.slice(4) : undefined);

/** A folder only the image's own PATH names: an exec given no PATH inherits it (as computerd's default does), one given
 *  the shell's fixed PATH does not search it. */
const IMAGE_ONLY_DIR = "/opt/media/bin";

/** Docker's stand-in: a box over the run's folder whose PATH has `has`, and `imageOnly` in IMAGE_ONLY_DIR, found only by
 *  an exec whose PATH names that folder or that gives none. Each exec.run's argv is kept in `execs`, its env in `envs`;
 *  `fails`, when set, is what an exec.run answers instead (a box that cannot be asked). */
function box(has, imageOnly = []) {
  const made = [];
  const released = [];
  const execs = [];
  const envs = [];
  const docker = { made, released, execs, envs, fails: undefined };
  docker.provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      const ref = { id: `c${made.length + 1}`, name: `c${made.length + 1}` };
      made.push({ ref, computer: fakeComputer(spec.mount.path, { exec: (params) => {
        const names = checked(params.argv) ?? [];
        const path = params.env?.PATH;
        const searchesImageOnly = path === undefined || path.split(":").includes(IMAGE_ONLY_DIR);
        const missing = names.filter((name) => !has.includes(name) && !(searchesImageOnly && imageOnly.includes(name)));
        return { exitCode: 0, stdout: Buffer.from(missing.map((name) => `${name}\n`).join("")), stderr: new Uint8Array(0), timedOut: false, truncated: false };
      } }) });
      return { ok: true, value: ref };
    },
    async connect(ref) {
      const one = made.find((each) => each.ref.id === ref.id);
      const client = {
        async call(method, params, options) {
          if (method === "exec.run") {
            execs.push(params.argv);
            envs.push(params.env);
            if (docker.fails) return docker.fails;
          }
          return one.computer.client.call(method, params, options);
        },
        close() {},
      };
      return { ok: true, value: { client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref) {
      const one = made.find((each) => each.ref.id === ref.id);
      if (!one) return { ok: false, error: { code: "not_found", message: `no fake computer has the id ${ref.id}` } };
      const read = await one.computer.readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release(ref) {
      released.push(ref.id);
      return { ok: true, value: undefined };
    },
  };
  return docker;
}

async function opened(t, { needs = MEDIA, has = MEDIA, imageOnly = [], computer: given } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-computer-needs-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [server];
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores.reverse()) await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const computer = given ?? { kind: "sandbox", provider: "docker", ...(needs ? { needs } : {}) };
  await server.agents.create({ id: "agent-1", name: "Film" }, { id: "rev-1", kind: "agentic", body: { instructions: "Render it.", computer, tools: ["read", "write"] } });
  const launch = { input: { content: "Render it." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const docker = box(has, imageOnly);
  const computerDeps = { kinds: KINDS, providers: { docker: () => docker.provider }, spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }), check: { readBackOf } };
  const ends = [];
  const start = async (fetch) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const route = { model: "claude-sonnet-5.5", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch };
    const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
    const onEvent = (event) => event.type === "released" && ends.push(event.end);
    runners.push(startRunner({ store, name: "runner-a", ...TIMING, onEvent, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) }));
  };
  const settled = (states) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && states.includes(ends.at(-1)) && now;
  }, `the run is released ${states.join(" or ")}`);
  const served = () => viewOverStore(server, RUN, { origin: "https://run.test", serverSecrets: () => [] });
  return { docker, start, settled, served };
}

const WRITE = { call: "write", args: { path: "notes.txt", content: "rendered" } };

test("a box that lacks programs the agent needs ends the run failed, naming them and the image fix; the model is never asked and the box is let go", { timeout: 120_000 }, async (t) => {
  const run = await opened(t, { has: ["chrome", "ffprobe"] });
  const requests = [];
  await run.start(scriptedOrigin([WRITE, { say: "done" }], requests));
  const row = await run.settled(["failed"]);
  assert.equal(row.state, "failed");
  assert.equal(requests.length, 0, "no model request was made");
  const served = await run.served();
  assert.equal(served.status, "failed");
  assert.equal(served.error.code, "run_failed", JSON.stringify(served.error));
  assert.equal(row.summary, served.error.message, "the run's own words");
  assert.match(served.error.message, /^This agent's sandbox on Docker lacks ffmpeg and hyperframes, which the agent needs \(computer\.needs\), so nothing ran\./, served.error.message);
  assert.match(served.error.message, /Set AGENTRUN_DOCKER_IMAGE to an image that has them/);
  assert.match(served.error.message, /packages\/computer\/media\/Dockerfile/, "the media image's build is named");
  assert.deepEqual(run.docker.made.map((one) => one.ref.id), ["c1"], "one box was started, to ask it");
  assert.deepEqual(run.docker.released, ["c1"], "and let go");
  assert.deepEqual(run.docker.execs.map(checked), [MEDIA], "asked once, the names as the sh's arguments");
  assert.ok(!run.docker.execs[0][2].includes("ffmpeg"), "no name is text of the script");
});

test("a box that has every program the agent needs runs the run as any other: the model is asked and the run completes", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  const requests = [];
  await run.start(scriptedOrigin([WRITE, { say: "done" }], requests));
  const row = await run.settled(["ended"]);
  assert.equal(row.state, "ended", "the run completes");
  assert.ok(requests.length >= 2, `the model was asked: ${requests.length}`);
  assert.deepEqual(run.docker.execs.map(checked), [MEDIA], "the box was asked once, before the run's work");
  assert.equal((await run.served()).error, null);
});

test("a program only on the image's own PATH, which the agent's shell does not search, is missing: the check searches the shell's PATH", { timeout: 120_000 }, async (t) => {
  const run = await opened(t, { has: ["chrome", "ffprobe", "hyperframes"], imageOnly: ["ffmpeg"] });
  const requests = [];
  await run.start(scriptedOrigin([WRITE, { say: "done" }], requests));
  const row = await run.settled(["failed"]);
  assert.equal(row.state, "failed", "never a pass the agent's bash would then fail");
  assert.equal(requests.length, 0, "no model request was made");
  assert.match((await run.served()).error.message, /^This agent's sandbox on Docker lacks ffmpeg, which the agent needs/);
  assert.equal(run.docker.envs[0]?.PATH, shellEnv().PATH, "the check's PATH is the agent's shell's");
  assert.deepEqual(run.docker.released, ["c1"], "the box is let go");
});

test("a box that cannot be asked ends the run failed in words, never as if it had them: the model is never asked", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  run.docker.fails = { ok: false, error: { code: "unavailable", message: "the connection to c1 ended" } };
  const requests = [];
  await run.start(scriptedOrigin([WRITE, { say: "done" }], requests));
  const row = await run.settled(["failed"]);
  assert.equal(requests.length, 0, "no model request was made");
  const served = await run.served();
  assert.equal(served.error.code, "run_failed");
  assert.equal(served.error.message, "This agent's sandbox on Docker could not be checked for what it needs (chrome, ffmpeg, ffprobe, hyperframes): the connection to c1 ended. Nothing ran.");
  assert.equal(row.state, "failed");
  assert.deepEqual(run.docker.released, ["c1"]);
});

test("an agent that needs nothing asks its box nothing", { timeout: 120_000 }, async (t) => {
  const run = await opened(t, { needs: null, has: [] });
  const requests = [];
  await run.start(scriptedOrigin([WRITE, { say: "done" }], requests));
  const row = await run.settled(["ended"]);
  assert.equal(row.state, "ended");
  assert.deepEqual(run.docker.execs.filter((argv) => checked(argv)), [], "no check ran");
});

// A setting with needs that is no sandbox: the validator refuses it (computer-setting.ts, needs on a sandbox alone), but a
// stored body is read as stored and a launch's computer as given, so the claim refuses it too: no run goes on without
// the programs because its computer was never one that is checked for them.
for (const [computer, what] of [[{ kind: "none", needs: MEDIA }, "none"], [{ kind: "desktop", provider: "e2b", needs: MEDIA }, "a desktop on E2B"]]) {
  test(`a setting that needs programs but is ${what}, no sandbox, ends the run failed in words before anything is started; the model is never asked`, { timeout: 120_000 }, async (t) => {
    const run = await opened(t, { computer });
    const requests = [];
    await run.start(scriptedOrigin([WRITE, { say: "done" }], requests));
    const row = await run.settled(["failed"]);
    assert.equal(row.state, "failed");
    assert.equal(requests.length, 0, "no model request was made");
    const served = await run.served();
    assert.equal(served.error.code, "run_failed", JSON.stringify(served.error));
    assert.equal(served.error.message.startsWith(`This agent needs chrome, ffmpeg, ffprobe, and hyperframes in a sandbox (computer.needs), and its computer is ${what}, which is not checked for them, so nothing ran. `), true, served.error.message);
    assert.match(served.error.message, /AGENTRUN_DOCKER_IMAGE/);
    assert.deepEqual(run.docker.made, [], "nothing was started");
  });
}
