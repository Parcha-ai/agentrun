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
import { allowed, container, fakeDocker, idOf, proxyReport } from "../../computer/test/fake-docker.mjs";
import { ofStore, startRunnerProcess } from "../dist/runner/main.js";
import { runHash } from "@parcha/agentrun-computer";
import { openSqliteStore } from "../dist/store/index.js";
import { startJanitor, sweepServerComputers } from "../dist/workspace/computer-janitor.js";
import { fauxLoops, until } from "./runner-support.mjs";
import { withEnv } from "./support.mjs";
import { memoryIntervals } from "./memory-intervals.mjs";

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

test("a computer of a run that is over is swept before its deadline: a later claim that failed before its computer left an earlier claim's running; a parked run's and a live run's older claim's wait for theirs", async () => {
  const FUTURE = new Date(NOW + 23 * 60 * 60_000);
  const docker = provider("docker", [
    { name: "ended-run-early", labels: labels("run-mine", 1), deadline: FUTURE },
    { name: "parked-early", labels: labels("run-parked", 2), deadline: FUTURE },
    { name: "live-older-early", labels: labels("run-live", 2), deadline: FUTURE },
    { name: "other-server-early", labels: labels("run-of-another-server", 1), deadline: FUTURE },
  ]);
  const swept = await sweepServerComputers({ store: store(), computers: computers([docker], { DOCKER_KEY: "k" }), now: () => NOW });
  assert.deepEqual(swept, [{ provider: "docker", swept: { ok: true, value: { deleted: ["ended-run-early"], kept: 2 } } }]);
  assert.deepEqual(docker.computers.map((one) => one.name), ["parked-early", "live-older-early", "other-server-early"]);
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

test("the runner's start removes the egress proxies and volumes this server's runs left with no computer: never another server's, never a live computer's", { skip: !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" }, async (t) => {
  const dir = dataDir(t);
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(() => server.close());
  await server.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  // Another runner holds run-1 at its claim's epoch, working on its computer D; E is an earlier claim's.
  const [claim] = await server.runs.claimMany("runner-other", 1, { leaseMs: 600_000 });
  const PAST_ISO = new Date(Date.now() - 60_000).toISOString();
  // Each proxy and volume as create made them, with the computer's spec labels (its run and epoch). B: this server's
  // run, its computer gone (a teardown that ended before its proxy). C: the same, of a run of another server on this
  // Docker host. D: this server's live computer, with its proxy. E: this server's computer past its deadline, which the
  // sweep ends as before (its line says the start's sweep ran).
  const partsOf = (name, run) => {
    const made = allowed({ name, allow: ["pypi.org"], labels: labels(run, 1) });
    return { containers: made.containers.filter((one) => one.Name !== `/${name}`), volumes: made.volumes };
  };
  const B = partsOf("computer-0000000000bb", "run-1");
  const C = partsOf("computer-0000000000cc", "run-of-another-server");
  const D = allowed({ name: "computer-0000000000dd", allow: ["pypi.org"], labels: labels("run-1", claim.epoch) });
  const fake = fakeDocker({
    containers: [...B.containers, ...C.containers, ...D.containers, container({ name: "computer-0000000000ee", labels: labels("run-1", 0), deadline: PAST_ISO })],
    volumes: [...B.volumes, ...C.volumes, ...D.volumes],
  });
  withEnv(t, { PATH: `${dirname(fake.program)}${delimiter}${process.env.PATH}`, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SERVE_FAUX"]);
  const said = [];
  const runner = await startRunnerProcess({ dataDir: dir, name: "runner-docker", janitor: true, warn: (line) => said.push(line) });
  t.after(() => runner.close());
  await until(async () => said.some((line) => line.includes("past their deadline: computer-0000000000ee")), "the start's sweep of docker", 30_000).catch((error) => assert.fail(`${error.message}; said: ${said.join(" | ")}`));
  assert.deepEqual(fake.names().sort(), ["computer-0000000000cc-egress", "computer-0000000000dd", "computer-0000000000dd-egress"]);
  assert.deepEqual(fake.volumeNames().sort(), ["computer-0000000000cc-egress", "computer-0000000000dd-egress"]);
});

test("the leftover sweep is asked for this server's alone: a run of this store (by its label or its hash), or an agent's whose owner names this server; never another server's, nor an owner it can't read", async () => {
  const orgo = provider("orgo", []);
  const asked = [];
  orgo.made.sweepLeftovers = async ({ mine }) => {
    const parts = {
      "run-label": labels("run-mine", 1),
      "run-hash": { "agentrun.run.hash": runHash("run-live") },
      "other-run": labels("run-of-another-server", 1),
      "other-hash": { "agentrun.run.hash": runHash("run-of-another-server") },
      "agent-here": { "agentrun.owner": "agent:agent-1", "agentrun.owner-server": "0123456789ab" },
      "agent-there": { "agentrun.owner": "agent:agent-1", "agentrun.owner-server": "ba9876543210" },
      "agent-unread": { "agentrun.owner": "not-an-agent", "agentrun.run": "run-mine" },
      unlabelled: {},
    };
    const removed = [];
    for (const [name, of] of Object.entries(parts)) if (await mine(of)) removed.push(name);
    asked.push(removed);
    return { ok: true, value: removed };
  };
  const settings = { putIfAbsent: async () => ({ v: 1, id: "0123456789ab" }), get: async () => undefined, all: async () => [] };
  const agents = { get: async () => undefined, list: async () => [] };
  const swept = await sweepServerComputers({ store: { ...store(), settings, agents }, computers: computers([orgo], { ORGO_KEY: "k" }), now: () => NOW });
  assert.deepEqual(swept, [{ provider: "orgo", swept: { ok: true, value: { deleted: [], kept: 0, leftovers: ["run-label", "run-hash", "agent-here"] } } }]);
  assert.equal(asked.length, 1);
});

/** Parts of Docker computer `name` with its computer gone, made long ago, each carrying `labels`: a leftover by every
 *  rule but whose it is. */
const leftoverOf = (name, labels) => {
  const made = allowed({ name, allow: ["pypi.org"], labels });
  return { containers: made.containers.filter((one) => one.Name !== `/${name}`), volumes: made.volumes };
};
/** A container and a volume named as computer `name`'s proxy, with no label of ours. */
const lookalikeOf = (name) => ({ containers: [proxyReport({ id: idOf(`${name}-egress`), name: `${name}-egress`, labels: {}, cmd: [] })], volumes: [{ Name: `${name}-egress`, Labels: {} }] });
const ANOTHER_SERVER = "ffffffffffff";
const ownedBy = (server) => ({ "agentrun.owner": "agent:agent-1", "agentrun.owner-server": server });
/** What may be deleted (1) and (2): of these, only `mine` is this server's. */
const notMine = (run) => ({
  bare: leftoverOf("computer-0000000000a1", {}),
  lookalike: lookalikeOf("computer-0000000000a2"),
  otherRun: leftoverOf("computer-0000000000a3", { ...labels("run-of-another-server", 1), ...ownedBy(ANOTHER_SERVER) }),
  myRunOtherOwner: leftoverOf("computer-0000000000a4", { ...labels(run, 1), ...ownedBy(ANOTHER_SERVER) }),
});
const KEPT = ["computer-0000000000a1-egress", "computer-0000000000a2-egress", "computer-0000000000a3-egress", "computer-0000000000a4-egress"];
/** Whether computer `name`'s proxy and volume are both gone from the fake host. */
const goneFrom = (fake, name) => !fake.names().includes(`${name}-egress`) && !fake.volumeNames().includes(`${name}-egress`);
const partsOfAll = (...sets) => ({ containers: sets.flatMap((one) => one.containers), volumes: sets.flatMap((one) => one.volumes) });

test("what may be deleted (1, 2): the runner's start never removes a part with neither label, one named like a proxy without ours, another server's run, or this store's run under another server's owner", { skip: !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" }, async (t) => {
  const dir = dataDir(t);
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(() => server.close());
  await server.agents.create({ id: "agent-1", name: "Agent one" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  // run-over: this store's, ended, so no claim will take it; its own orphan shows the start's sweep ran.
  await server.runs.create({ id: "run-over", agentId: "agent-1", revisionId: "rev-1" });
  assert.deepEqual(await server.runs.failUnclaimed("ended for the test"), ["run-over"]);
  const others = notMine("run-over");
  const fake = fakeDocker(partsOfAll(...Object.values(others), leftoverOf("computer-0000000000a5", labels("run-over", 1))));
  withEnv(t, { PATH: `${dirname(fake.program)}${delimiter}${process.env.PATH}`, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["AGENTRUN_SERVE_FAUX"]);
  const said = [];
  const runner = await startRunnerProcess({ dataDir: dir, name: "runner-docker", janitor: true, warn: (line) => said.push(line) });
  t.after(() => runner.close());
  await until(async () => goneFrom(fake, "computer-0000000000a5"), "the start's sweep of docker", 30_000).catch((error) => assert.fail(`${error.message}; said: ${said.join(" | ")}`));
  assert.deepEqual(fake.names().sort(), KEPT);
  assert.deepEqual(fake.volumeNames().sort(), KEPT);
});

test("what may be deleted (1, 2): the janitor's interval sweeps never remove them either", { skip: !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)" }, async (t) => {
  const fake = fakeDocker(partsOfAll(...Object.values(notMine("run-mine")), leftoverOf("computer-0000000000a5", labels("run-mine", 1))));
  const settings = { putIfAbsent: async () => ({ v: 1, id: "0123456789ab" }), get: async () => undefined, all: async () => [] };
  const agents = { get: async () => undefined, list: async () => [] };
  const said = [];
  const janitor = startJanitor({ store: { ...store(), settings, agents }, computers: computers([{ made: fake.provider }], { DOCKER_KEY: "k" }), env: {}, log: (line) => said.push(line), everyMs: 20, now: () => NOW });
  t.after(() => janitor.close());
  await janitor.first;
  await until(async () => goneFrom(fake, "computer-0000000000a5"), "the start's sweep", 30_000);
  assert.ok(goneFrom(fake, "computer-0000000000a5"), `the start's sweep removed this server's orphan; said: ${said.join(" | ")}`);
  // Another orphan of this server's run, left after the start: the interval's sweep removes it, and nothing else.
  fake.add(...Object.values(leftoverOf("computer-0000000000a6", labels("run-mine", 1))));
  await until(async () => goneFrom(fake, "computer-0000000000a6"), "the interval's sweep", 30_000);
  // And one more interval after it.
  const sweeps = () => fake.calls().filter((args) => args[0] === "ps" && args.includes("label=agentrun.computer.egress")).length;
  const seen = sweeps();
  await until(async () => sweeps() > seen, "one more interval", 30_000);
  assert.deepEqual(fake.names().sort(), KEPT);
  assert.deepEqual(fake.volumeNames().sort(), KEPT);
});

test("a computer the sweep deleted ends its run's interval at the sweep's time; one whose delete failed stays open (computer-intervals.ts)", async () => {
  const docker = provider("docker", [
    { name: "mine-late", labels: labels("run-mine", 1), deadline: PAST },
    { name: "parked-run-out", labels: labels("run-parked", 2), deadline: PAST },
  ]);
  // The vendor refuses the second delete: nothing proves it ended.
  const release = docker.made.release;
  docker.made.release = async (ref, how) => (ref.name === "parked-run-out" ? { ok: false, error: { code: "unavailable", message: "the vendor did not answer" } } : release(ref, how));
  const intervals = memoryIntervals();
  const opened = (providerId, runId) => intervals.opened({ runId, provider: "docker", providerId, kind: "sandbox", gpuType: null, gpuCount: null, cpus: null, memoryMb: null, startedAt: NOW - 3_600_000 });
  await opened("mine-late", "run-mine");
  await opened("parked-run-out", "run-parked");
  await sweepServerComputers({ store: { ...store(), computerIntervals: intervals }, computers: computers([docker], { DOCKER_KEY: "k" }), now: () => NOW });
  assert.deepEqual((await intervals.forRun("run-mine")).map((row) => [row.providerId, row.endedAt]), [["mine-late", NOW]]);
  assert.deepEqual((await intervals.forRun("run-parked")).map((row) => [row.providerId, row.endedAt]), [["parked-run-out", null]]);
});
