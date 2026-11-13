// The computer janitor (workspace/computer-janitor.ts): at the runner's start, then on its interval, it ends each computer
// of this server past its deadline, over each provider whose keys the server has and whose vendor doesn't end its own.
// Never another server's computer (its run is not in this store), never one a claim holds, and a provider that fails is
// said and the others swept. Its close never waits on a stuck vendor past its bound. The runner process starts it only
// when asked, and never under --faux.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { container, fakeDocker } from "../../computer/test/fake-docker.mjs";
import { ofStore, startRunnerProcess } from "../dist/runner/main.js";
import { openSqliteStore } from "../dist/store/index.js";
import { startJanitor, sweepServerComputers } from "../dist/workspace/computer-janitor.js";
import { fauxLoops, until } from "./runner-support.mjs";
import { withEnv } from "./support.mjs";

const NOW = 1_800_000_000_000;
const PAST = new Date(NOW - 60_000);

/** A provider whose computers are `computers` ({ name, labels, deadline }), ended by release; `failing` makes its list
 *  fail in words, `hanging` makes it never answer, whatever its signal. Its lifetime is the janitor's unless `lifetime`
 *  says otherwise. */
function provider(id, computers, { failing, hanging, lifetime = "janitor" } = {}) {
  const released = [];
  return {
    released,
    computers,
    made: {
      id, version: "1",
      capabilities: () => ({ lifetime, maxLifetimeMs: 24 * 60 * 60_000 }),
      check: () => [],
      async list() {
        if (hanging) return new Promise(() => {});
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

/** This server's runs: one ended (its computer left by a crashed runner); one held by a claim at epoch 3; one a crashed
 *  runner left parked under its name at epoch 2, its claim run out. `held` is what the store says of each claim now, by
 *  its own clock (runs.heldAt); the rows' claimedUntil, read on this process's clock, would say otherwise. */
const RUNS = {
  "run-mine": { id: "run-mine", state: "ended", epoch: 1, runner: null, claimedUntil: null, held: undefined },
  "run-live": { id: "run-live", state: "running", epoch: 3, runner: "runner-b", claimedUntil: NOW - 60_000, held: 3 },
  "run-parked": { id: "run-parked", state: "parked", epoch: 2, runner: "runner-c", claimedUntil: NOW + 60_000, held: undefined },
};
const store = (runs = RUNS) => ({ runs: { get: async (id) => runs[id], list: async () => Object.values(runs), heldAt: async (id) => runs[id]?.held }, computerLedger: {} });

/** The computers as the runner composed them: a registry of `providers`, each with a key named <ID>_KEY, and the key
 *  reader answering the keys in `keys`; a key named in `unreadable` throws as a store that can't be read. */
function computers(providers, keys, unreadable = []) {
  const PROVIDERS = providers.map(({ made }) => ({ id: made.id, label: made.id, keys: [{ name: `${made.id.toUpperCase()}_KEY`, option: "apiKey", required: true }] }));
  return {
    kinds: { PROVIDERS },
    providers: Object.fromEntries(providers.map(({ made }) => [made.id, async () => made])),
    keyOf: async (name) => {
      if (unreadable.includes(name)) throw new Error(`the store could not open ${name}`);
      return keys[name];
    },
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

test("a claimed run's computer of an older epoch is a lost claim's, and is swept; one with no readable epoch is kept", async () => {
  const docker = provider("docker", [
    { name: "older-epoch", labels: labels("run-live", 2), deadline: PAST },
    { name: "no-epoch", labels: { "agentrun.run": "run-live" }, deadline: PAST },
    { name: "no-run", labels: {}, deadline: PAST },
  ]);
  await sweepServerComputers({ store: store(), computers: computers([docker], { DOCKER_KEY: "k" }), now: () => NOW });
  assert.deepEqual(docker.released, [["older-epoch", "delete"]]);
});

test("whether a claim holds a run is the store's to say, never this process's clock: a held claim keeps its computer, and a parked run whose crashed runner's claim ran out does not (review)", async () => {
  const docker = provider("docker", [
    { name: "held-by-store", labels: labels("run-live", 3), deadline: PAST },
    { name: "parked-run-out", labels: labels("run-parked", 2), deadline: PAST },
  ]);
  await sweepServerComputers({ store: store(), computers: computers([docker], { DOCKER_KEY: "k" }), now: () => NOW });
  assert.deepEqual(docker.released, [["parked-run-out", "delete"]]);
});

test("a provider that keeps only the run's hash (Orgo's names) is swept by it: the hash of this store's run, and never another's (review)", async () => {
  const { runHash } = await import("@parcha/agentrun-computer");
  const orgo = provider("orgo", [
    { name: "mine-by-hash", labels: { "agentrun.run.hash": runHash("run-mine"), "agentrun.epoch": "1" }, deadline: PAST },
    { name: "other-by-hash", labels: { "agentrun.run.hash": runHash("run-of-another-server"), "agentrun.epoch": "1" }, deadline: PAST },
    { name: "held-by-hash", labels: { "agentrun.run.hash": runHash("run-live"), "agentrun.epoch": "3" }, deadline: PAST },
  ]);
  await sweepServerComputers({ store: store(), computers: computers([orgo], { ORGO_KEY: "k" }), now: () => NOW });
  assert.deepEqual(orgo.released, [["mine-by-hash", "delete"]]);
});

test("a key that can't be read fails that provider alone: the others are swept (review)", async () => {
  const modal = provider("modal", theThree());
  const orgo = provider("orgo", theThree());
  const swept = await sweepServerComputers({ store: store(), computers: computers([modal, orgo], { ORGO_KEY: "k" }, ["MODAL_KEY"]), now: () => NOW });
  assert.deepEqual(swept.map(({ provider, swept }) => [provider, swept.ok]), [["modal", false], ["orgo", true]]);
  assert.match(swept[0].swept.error.message, /could not open MODAL_KEY/);
  assert.deepEqual(orgo.released, [["mine-late", "delete"]]);
});

test("a provider whose sweep is stuck is cut at its bound and said as a timeout, and the next provider is still swept (review)", async () => {
  const stuck = provider("docker", theThree(), { hanging: true });
  const orgo = provider("orgo", theThree());
  const swept = await sweepServerComputers({ store: store(), computers: computers([stuck, orgo], { DOCKER_KEY: "k", ORGO_KEY: "k" }), now: () => NOW, providerMs: 50 });
  assert.deepEqual(swept.map(({ provider, swept }) => [provider, swept.ok ? "ok" : swept.error.code]), [["docker", "timeout"], ["orgo", "ok"]]);
  assert.deepEqual(orgo.released, [["mine-late", "delete"]]);
});

test("closing the janitor never waits on a stuck vendor call past its bound (review)", async () => {
  const stuck = provider("docker", theThree(), { hanging: true });
  const janitor = startJanitor({ store: store(), computers: computers([stuck], { DOCKER_KEY: "k" }), env: {}, log: () => {}, closeMs: 50, now: () => NOW });
  const started = Date.now();
  await janitor.close();
  assert.ok(Date.now() - started < 5_000, `close returned in ${Date.now() - started} ms`);
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

test("runs.heldAt is the store's word on a claim, by its own clock: the claim's epoch while it holds, nothing once its lease runs out", async (t) => {
  let clock = NOW;
  const server = await openSqliteStore({ dataDir: dataDir(t), role: "server", now: () => clock });
  t.after(() => server.close());
  await server.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  assert.equal(await server.runs.heldAt("run-1"), undefined, "queued: no claim holds it");
  const [claim] = await server.runs.claimMany("runner-a", 1, { leaseMs: 1_000 });
  assert.equal(await server.runs.heldAt("run-1"), claim.epoch);
  clock += 2_000;
  const row = await server.runs.get("run-1");
  assert.equal(row.runner, "runner-a", "the row still names its runner");
  assert.equal(await server.runs.heldAt("run-1"), undefined, "its lease ran out on the store's clock: nothing holds it");
  assert.equal(await server.runs.heldAt("no-such-run"), undefined);
});

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

// The Docker computer's daemon file, which the computer package's build:daemon makes with Go (CI's build job does): the
// runner's Docker provider is made only where it is there. The fake docker never runs it.
const DAEMON = fileURLToPath(new URL("../../computer/dist/computerd-linux-amd64", import.meta.url));

test("the runner's own composition sweeps Docker past a labelled container made with no --mount: this server's late computer ends, the other is kept", { skip: !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" }, async (t) => {
  const dir = dataDir(t);
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(() => server.close());
  await server.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  // The docker CLI on PATH is the computer package's fake, which runs a --format template as Docker does (a key the
  // inspect lacks fails the call). Beside this server's late computer, one made by hand with the computer label and no
  // --mount, of a run this store doesn't have: Docker leaves HostConfig.Mounts out of its inspect.
  const PAST_ISO = new Date(Date.now() - 60_000).toISOString();
  const bare = container({ name: "computer-0000000000dd", labels: { "agentrun.run": "run-of-another-server" }, deadline: PAST_ISO });
  delete bare.HostConfig.Mounts;
  bare.Mounts = [];
  const fake = fakeDocker({ containers: [container({ name: "computer-0000000000aa", labels: labels("run-1", 0), deadline: PAST_ISO }), bare] });
  withEnv(t, { PATH: `${dirname(fake.program)}${delimiter}${process.env.PATH}`, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SERVE_FAUX"]);
  const said = [];
  const runner = await startRunnerProcess({ dataDir: dir, name: "runner-docker", janitor: true, warn: (line) => said.push(line) });
  t.after(() => runner.close());
  await until(async () => said.some((line) => line.includes("docker")), "the start's sweep of docker");
  assert.deepEqual(said.filter((line) => line.includes("docker")), ["the computer janitor ended docker's computers past their deadline: computer-0000000000aa"]);
  assert.deepEqual(fake.names(), ["computer-0000000000dd"]);
});
