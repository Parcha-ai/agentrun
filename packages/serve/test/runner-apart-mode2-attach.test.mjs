// A Mode 2 run on the path a staging run takes: a server started with its runner apart (--no-runner, the image's
// server-and-runner), one runner of its own on the same data (support.mjs startInProcessRunner: the runner's code in the
// test's process, where its fakes reach it), and the run in a process of its own (run-child.ts), so the
// mount check its process builds (computerHere: the computer package's readBackOf, under the claim's epoch) reaches the
// runner's Archil Workspace across the run channel, where its readBackOf is a handle whose call answers as a promise.
// The computer is an E2B sandbox on a fake provider in the runner, over a local folder; the disk is the Archil fake.
// A computer whose read-back is exact is attached: the run's attached Workspace makes its scratch through the computer
// and the run completes (v0.1.0-beta.46 refused every Mode 2 run, its readBackOf unawaited). A refusal's words over the
// run channel are workspace-archil-mount.test.mjs's.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { agent, client, FAUX, follow, startInProcessRunner, startServe, whenFree, withEnv, writableTree } from "./support.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { saveArchilSettings } = await import("../dist/archil-settings.js");
const { claimComputer } = await import("../dist/workspace/index.js");

const REGION = "aws-us-east-1";
const FAKE_ARCHIL = "fake-test-key-archil-m2-0001";
const FAKE_E2B = "fake-test-key-e2b-m2-0001";
const KEYS = { ARCHIL_API_KEY: FAKE_ARCHIL, E2B_API_KEY: FAKE_E2B };
const UNSET = ["AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE", "AGENTRUN_SEAL_KEY"];

/** A server with its runner apart, in Mode 2, and one runner of its own whose runs each run in a process of their own.
 *  The runner's computer for a claim is the runner's own composition (its check, its keys, its spec) on the test's kind
 *  registry, E2B's provider the fake: its create takes the Archil mount it is asked for, and its read-back is that mount's
 *  under the claim's epoch. */
async function apart(t) {
  withEnv(t, KEYS, [...Object.keys(KEYS), ...UNSET]);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-apart-mode2-"));
  const data = join(dir, "agents");
  const folder = join(dir, "computer");
  mkdirSync(folder);
  const server = await startServe({ data, port: 0, faux: FAUX, runnerApart: true, mcpLoopback: true, drainTimeout: "5s" });
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.();
    await store.close().catch(() => {});
    await server.close();
    await writableTree(dir).then(() => rm(dir, { recursive: true, force: true }));
  });
  await saveArchilSettings(store, { region: REGION, s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  const computer = fakeComputer(folder);
  const made = { mounts: [], epochs: [], readBacks: [] };
  let epoch;
  let mounted;
  const provider = {
    id: "e2b", version: "0", capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }), check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:test" }),
    list: async () => ({ ok: true, value: [] }),
    create: async (spec) => {
      assert.equal(spec.mount?.kind, "archil", "the run's folder is mounted from its Archil disk");
      made.mounts.push(spec.mount);
      mounted = readBackOf(spec.mount, epoch);
      return { ok: true, value: { id: `c${made.mounts.length}`, name: `c${made.mounts.length}` } };
    },
    connect: async () => ({ ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } }),
    attach: async ({ id }) => {
      made.readBacks.push(mounted);
      return { ok: true, value: { id, name: id, spec: { image: "i", user: "1000:1000", network: "none", mount: mounted } } };
    },
    release: async () => ({ ok: true, value: undefined }),
  };
  const disk = new FakeArchilDisk();
  const control = archilControlFetch({ region: REGION });
  const lines = [];
  runner = await startInProcessRunner(data, {
    faux: FAUX,
    mcpOwn: server.own,
    childRuns: { log: (line) => void lines.push(line) },
    archil: { makeDisk: () => disk, control: { baseUrl: control.baseUrl, fetch: control.fetch } },
    computerForClaim: (launch, claimStore, given) => {
      epoch = launch.epoch;
      made.epochs.push(launch.epoch);
      return claimComputer(launch, claimStore, { ...given, kinds: KINDS, providers: { ...given.providers, e2b: () => provider } });
    },
  });
  const api = client(server.baseUrl, server.token);
  const runOf = async (id) => {
    const saved = await whenFree(() => api("POST", "/agents", agent(id, { tools: ["read", "write"], computer: { kind: "sandbox", provider: "e2b" } })));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const started = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: "Answer." } }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    return { runId, run: (await api("GET", `/runs/${runId}`)).body };
  };
  return { api, computer, folder, made, lines, runOf };
}

test("runner apart, the run in its own process: a computer whose Archil read-back is exact is attached across the run channel, its scratch made through it, and the run completes", { timeout: 180_000 }, async (t) => {
  const { computer, folder, made, lines, runOf } = await apart(t);
  const { runId, run } = await runOf("mode2-exact");
  const said = JSON.stringify(run);
  assert.ok(!said.includes("undefined:/undefined"), `the run was not refused for its mount: ${said}\n${lines.join("\n")}`);
  assert.equal(run.status, "completed", `${said}\n${lines.join("\n")}`);
  assert.equal(made.mounts.length, 1, "one computer, made with the run's Archil mount");
  const [mount] = made.mounts;
  assert.ok(mount.folder.includes(runId), `the mount is the run's folder: ${mount.folder}`);
  assert.equal(mount.region, REGION);
  assert.ok(made.readBacks.length >= 1, "the computer was asked what it mounts");
  assert.deepEqual(made.readBacks.at(-1), { kind: "archil", disk: mount.disk, region: REGION, folder: mount.folder, exclusive: true, epoch: made.epochs[0] });
  // Past the attach: the run's hands make the attached Workspace's scratch (run-tools.ts TMP_DIR) through the computer,
  // onto the folder it mounts; the run's end sweeps it there.
  const mkdirs = computer.calls.filter(([method, params]) => method === "files.mkdir" && params.path === "/workspace/.agentrun/tmp");
  assert.equal(mkdirs.length, 1, `the attached Workspace made its scratch through the computer: ${JSON.stringify(computer.calls.map(([method, params]) => [method, params?.path]))}`);
  assert.ok(existsSync(join(folder, ".agentrun")), "on the folder the computer mounts");
});
