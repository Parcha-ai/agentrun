// The computer janitor (workspace/computer-janitor.ts): at the runner's start, then on its interval, it ends each computer
// of this server past its deadline, over each provider whose keys the server has and whose vendor doesn't end its own.
// Never another server's computer (its run is not in this store), never one a live claim holds, and a provider that
// fails is said and the others swept. The runner process starts it only when asked, and never under --faux.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ofStore, startRunnerProcess } from "../dist/runner/main.js";
import { openSqliteStore } from "../dist/store/index.js";
import { startJanitor, sweepServerComputers } from "../dist/workspace/computer-janitor.js";
import { fauxLoops, until } from "./runner-support.mjs";

const NOW = 1_800_000_000_000;
const PAST = new Date(NOW - 60_000);
const AHEAD = new Date(NOW + 60 * 60_000);

/** A provider whose computers are `computers` ({ name, labels, deadline }), ended by release; `failing` makes its list
 *  fail in words. Its lifetime is the janitor's unless `lifetime` says otherwise. */
function provider(id, computers, { failing, lifetime = "janitor" } = {}) {
  const released = [];
  return {
    released,
    computers,
    made: {
      id, version: "1",
      capabilities: () => ({ lifetime, maxLifetimeMs: 24 * 60 * 60_000 }),
      check: () => [],
      async list() {
        if (failing) return { ok: false, error: { code: "unreachable", message: `${id}'s vendor did not answer` } };
        return { ok: true, value: computers.map((one) => ({ ref: { id: one.name, name: one.name }, labels: one.labels, deadline: one.deadline, state: "running", network: "none" })) };
      },
      async release(ref, how) {
        released.push([ref.name, how]);
        computers.splice(computers.findIndex((one) => one.name === ref.name), 1);
        return { ok: true, value: undefined };
      },
    },
  };
}

const labels = (run, epoch) => ({ "agentrun.run": run, "agentrun.epoch": String(epoch) });

/** This server's runs: one ended (its computer left by a crashed runner), one held by a live claim at epoch 3. */
const RUNS = {
  "run-mine": { id: "run-mine", state: "ended", epoch: 1, runner: null, claimedUntil: null },
  "run-live": { id: "run-live", state: "running", epoch: 3, runner: "runner-b", claimedUntil: NOW + 60_000 },
};
const store = (runs = RUNS) => ({ runs: { get: async (id) => runs[id] }, computerLedger: {} });

/** The computers as the runner composed them: a registry of `providers`, each with a key named <ID>_KEY, and the key
 *  reader answering the keys in `keys`. */
function computers(providers, keys) {
  const PROVIDERS = providers.map(({ made }) => ({ id: made.id, label: made.id, keys: [{ name: `${made.id.toUpperCase()}_KEY`, option: "apiKey", required: true }] }));
  return {
    kinds: { PROVIDERS },
    providers: Object.fromEntries(providers.map(({ made }) => [made.id, async () => made])),
    keyOf: async (name) => keys[name],
    keyTable: { keys: Object.fromEntries(PROVIDERS.map((entry) => [entry.id, entry.keys])), labels: {} },
  };
}

const theThree = () => [
  { name: "mine-late", labels: labels("run-mine", 1), deadline: PAST },
  { name: "other-server", labels: labels("run-of-another-server", 1), deadline: PAST },
  { name: "live-held", labels: labels("run-live", 3), deadline: PAST },
];

test("a sweep ends only this server's computer past its deadline: never another server's, never one a live claim holds", async () => {
  const orgo = provider("orgo", theThree());
  const swept = await sweepServerComputers({ store: store(), computers: computers([orgo], { ORGO_KEY: "k" }), now: () => NOW });
  assert.deepEqual(swept, [{ provider: "orgo", swept: { ok: true, value: { deleted: ["mine-late"], kept: 0 } } }]);
  assert.deepEqual(orgo.released, [["mine-late", "delete"]]);
  assert.deepEqual(orgo.computers.map((one) => one.name), ["other-server", "live-held"]);
});

test("a live run's computer of an older epoch is a lost claim's, and is swept; one with no readable epoch is kept", async () => {
  const docker = provider("docker", [
    { name: "older-epoch", labels: labels("run-live", 2), deadline: PAST },
    { name: "no-epoch", labels: { "agentrun.run": "run-live" }, deadline: PAST },
    { name: "no-run", labels: {}, deadline: PAST },
  ]);
  await sweepServerComputers({ store: store(), computers: computers([docker], { DOCKER_KEY: "k" }), now: () => NOW });
  assert.deepEqual(docker.released, [["older-epoch", "delete"]]);
});

test("a provider whose keys aren't here, or whose vendor ends its own computers, is not asked", async () => {
  const keyless = provider("orgo", theThree());
  const vendor = provider("daytona", theThree(), { lifetime: "vendor" });
  const swept = await sweepServerComputers({ store: store(), computers: computers([keyless, vendor], { DAYTONA_KEY: "k" }), now: () => NOW });
  assert.deepEqual(swept, []);
  assert.deepEqual([keyless.released, vendor.released], [[], []]);
});

test("the janitor sweeps at its start and then on its interval; a failing provider is said once and the others are swept", async (t) => {
  const failing = provider("modal", theThree(), { failing: true });
  const orgo = provider("orgo", theThree());
  const said = [];
  const janitor = startJanitor({ store: store(), computers: computers([failing, orgo], { MODAL_KEY: "k", ORGO_KEY: "k" }), env: {}, log: (line) => said.push(line), everyMs: 20, now: () => NOW });
  t.after(() => janitor.close());
  await janitor.first;
  assert.deepEqual(orgo.released, [["mine-late", "delete"]], "the start's sweep ended this server's late computer");
  assert.deepEqual(said, ["the computer janitor could not sweep modal's computers: modal's vendor did not answer", "the computer janitor ended orgo's computers past their deadline: mine-late"]);

  // A computer of this server that is late now: the interval's sweep ends it.
  orgo.computers.push({ name: "mine-later", labels: labels("run-mine", 1), deadline: PAST });
  await until(async () => orgo.released.length === 2, "the interval's sweep");
  assert.deepEqual(orgo.released.at(-1), ["mine-later", "delete"]);
  assert.equal(said.filter((line) => line.includes("modal")).length, 1, "the same failure is said once");
  assert.deepEqual(orgo.computers.map((one) => one.name), ["other-server", "live-held"]);
});

test("under --faux the janitor never sweeps", async () => {
  const orgo = provider("orgo", theThree());
  const janitor = startJanitor({ store: store(), computers: computers([orgo], { ORGO_KEY: "k" }), env: { AGENTRUN_SERVE_FAUX: "/faux.mjs" }, log: () => {}, everyMs: 5, now: () => NOW });
  await janitor.first;
  await new Promise((resolve) => setTimeout(resolve, 30));
  await janitor.close();
  assert.deepEqual(orgo.released, []);
});

function dataDir(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-janitor-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the runner process sweeps at its start when asked, with the computers its loop composed; without asking it never does", async (t) => {
  const dir = dataDir(t);
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(() => server.close());
  await server.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const env = { ...process.env, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
  delete env.AGENTRUN_SERVE_FAUX;
  for (const janitor of [false, true]) {
    // run-1 is this store's; its computer's deadline has passed (the real clock: the runner's own).
    const orgo = provider("orgo", [{ name: "late", labels: labels("run-1", 0), deadline: new Date(Date.now() - 60_000) }]);
    const faux = fauxLoops();
    const made = ofStore(() => ({ createLoop: faux.createLoop, computers: computers([orgo], { ORGO_KEY: "k" }), env }));
    const runner = await startRunnerProcess({ dataDir: dir, name: `runner-${janitor}`, env, createLoop: made, janitor, warn: () => {} });
    if (janitor) await until(async () => orgo.released.length === 1, "the start's sweep");
    await runner.close();
    assert.deepEqual(orgo.released, janitor ? [["late", "delete"]] : [], janitor ? "asked: swept" : "not asked: never swept");
  }
});
