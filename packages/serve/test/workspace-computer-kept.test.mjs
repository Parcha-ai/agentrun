// A desktop or a phone kept through its run's park (serve/src/workspace/computer-kept.ts, computer-for-claim.ts park and
// re-attach): the claim that parks keeps the machine running for 10 minutes, its row in the server's settings; a resume
// within that time attaches the same one (no create, nothing of the run's let go, not called a new one), and a resume
// after it makes a new one, said so with why. The janitor's pass over the rows (sweepKept) ends one past its time, or
// whose run ended, whatever process parked it: a server's restart keeps it found, and ended, on time. A sandbox is kept
// the same way; a paired computer and --faux's desktop are never kept. Every provider is a loopback fake that keeps its computers across
// claims, as a vendor's account does; the clock is the test's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AttachHub, readBackOf } from "@parcha/agentrun-computer";
import { FakeUiDriver, serveUiSocket } from "@parcha/agentrun-computer/fake-ui-driver";
import { getSealedKey, putSealedKey } from "../dist/server-keys.js";
import { archilWorkspace, computerForClaim, localWorkspace, runKey } from "../dist/workspace/index.js";
import { FakeArchilDisk, FakeDiskError } from "./fixtures/archil-fake.mjs";
import { pairedOf } from "../dist/workspace/attached-computers.js";
import { fauxComputers } from "../dist/faux-computers.js";
import { computerKeptWords, computerReadyWords, computerReplacedNote } from "../dist/workspace/computer-deps.js";
import { computerLapsedWords, endKept, KEEP_MS, keptKeyOf, readKept, sweepKept, writeKept } from "../dist/workspace/computer-kept.js";
import { startJanitor, sweepKeptComputers } from "../dist/workspace/computer-janitor.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-kept-computer-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}

/** The server's settings in memory, as the store keeps them: a compare-and-set on the JSON text, a prefix read. */
function memorySettings() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    put: async (key, value) => void rows.set(key, structuredClone(value)),
    replaceIf: async (key, was, value) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) && (rows.set(key, structuredClone(value)), true),
    removeIf: async (key, was) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) && rows.delete(key),
    remove: async (key) => void rows.delete(key),
    all: async (filter) => [...rows].filter(([key]) => !filter?.prefix || key.startsWith(filter.prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
  };
}

/** The store parts the claim reads, its settings shared by every claim and the janitor (one server's store). */
function memoryStore() {
  const keys = new Map();
  const runs = new Map([["run-1", { id: "run-1", state: "parked", epoch: 0, runner: null }]]);
  return {
    // `take`: a runner's claim of the run, at `epoch` (the store's claim moves the epoch up and names the runner); `end`:
    // its end, park or release commit (the epoch up by one, no runner).
    runs: {
      get: async (id) => runs.get(id),
      heldAt: async () => undefined,
      list: async () => [...runs.values()],
      set: (id, state) => runs.set(id, { ...runs.get(id), id, state }),
      take: (id, epoch) => runs.set(id, { ...runs.get(id), epoch, runner: `runner-${epoch}` }),
      end: (id) => runs.set(id, { ...runs.get(id), epoch: runs.get(id).epoch + 1, runner: null }),
    },
    agents: { revision: async () => undefined },
    settings: memorySettings(),
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async (name) => void keys.delete(name), all: async () => [...keys].map(([name]) => ({ name })) },
    computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
  };
}

/** A vendor's account: its computers by id, kept across claims (and across a server's restart). Create makes `c<n>`
 *  under the spec's labels; attach finds one and reads its mount back under its own epoch label, as a provider reads it;
 *  delete ends it. Every call is recorded. */
function vendor(root, groups, machine = "linux") {
  const computers = new Map();
  const calls = [];
  const computer = fakeComputer(root);
  let made = 0;
  const provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    async list(labels) {
      calls.push(["list", labels]);
      const held = [...computers.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: { id: one.id, name: one.id }, labels: { ...one.labels }, deadline: new Date(Date.now() + 3_600_000), state: "running", network: "none" })) };
    },
    async create(spec) {
      const id = `c${++made}`;
      calls.push(["create", id]);
      computers.set(id, { id, labels: { ...spec.labels }, mount: spec.mount });
      return { ok: true, value: { id, name: id } };
    },
    async connect({ id }) {
      calls.push(["connect", id]);
      if (!computers.has(id)) return { ok: false, error: { code: "gone", message: `no computer ${id}` } };
      const os = machine === "android" ? { os: "android", osVersion: "15" } : { os: "linux" };
      return { ok: true, value: { client: computer.client, hello: { version: "0", ...os, kind: machine, arch: "amd64", groups }, close: async () => void calls.push(["close", id]) } };
    },
    async attach({ id }) {
      calls.push(["attach", id]);
      const one = computers.get(id);
      if (!one) return { ok: false, error: { code: "not_found", message: `no computer ${id}` } };
      const mount = one.mount ? readBackOf(one.mount, Number(one.labels["agentrun.epoch"])) : undefined;
      return { ok: true, value: { id, name: id, spec: { image: "i", user: "1000:1000", network: "none", ...(mount ? { mount } : {}) } } };
    },
    async watch() {
      return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => {} } };
    },
    async release(ref, how) {
      calls.push(["release", ref.id, how]);
      if (!computers.has(ref.id)) return { ok: false, error: { code: "not_found", message: `no computer ${ref.id}` } };
      if (how === "delete") computers.delete(ref.id);
      return { ok: true, value: undefined };
    },
  };
  return { provider, computers, calls, computer };
}

const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];
const PHONE_GROUPS = ["screen", "input.touch", "input.keys", "apps", "ui"];
const E2B_DESKTOP = { kind: "desktop", provider: "e2b" };
const SPEC = () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" });
const T0 = 1_800_000_000_000;

/** One server: its store, a vendor's account, a clock, and its claims of run-1 (each a claim at `epoch`). */
async function server({ setting = E2B_DESKTOP, mode = 1, groups = DESKTOP_GROUPS, machine, keys = { E2B_API_KEY: "fake-test-key" }, workspace } = {}) {
  const root = scratch();
  const store = memoryStore();
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, sealKey, name, value);
  const account = vendor(root, groups, machine);
  const clock = { now: T0 };
  const providers = Object.fromEntries(["docker", "e2b", "agent37", "phone-harness", "daytona"].map((id) => [id, () => account.provider]));
  const mounts = { revoked: 0, inherited: 0 };
  const deps = { mode, kinds: KINDS, sealKey, providers, spec: SPEC, workspace: workspace ?? localWorkspace(root), revokeMount: async () => void (mounts.revoked += 1), inheritMount: () => void (mounts.inherited += 1), now: () => clock.now };
  const claim = (epoch, extra = {}) => {
    store.runs.take("run-1", epoch);
    return computerForClaim({ runId: "run-1", epoch, computer: setting }, store, { ...deps, check: { readBackOf, epoch }, ...extra });
  };
  const janitor = () => sweepKeptComputers({ store, computers: { kinds: KINDS, providers, keyOf: (name) => getSealedKey(store, sealKey, name) }, now: () => clock.now });
  return { store, account, clock, mounts, claim, janitor, sealKey, keys };
}

const creates = (account) => account.calls.filter(([verb]) => verb === "create").map(([, id]) => id);
const deletes = (account) => account.calls.filter(([verb, , how]) => verb === "release" && how === "delete").map(([, id]) => id);

test("a desktop parked and resumed within 10 minutes is the same computer: attached again, no create, nothing let go, never called a new one, its mount credential kept", async () => {
  const one = await server();
  const said = [];
  const first = await one.claim(3);
  assert.equal(first.keeps, "desktop", "the claim's desktop is one a park keeps");
  assert.equal(await first.park(), true, "kept");
  assert.deepEqual(deletes(one.account), [], "nothing deleted at the park");
  assert.equal(one.mounts.revoked, 0, "its mount credential is left in place");
  assert.deepEqual(one.account.calls.at(-1), ["close", "c1"], "its connection closed, the machine left running");
  const row = await readKept(one.store.settings, "run-1");
  assert.deepEqual(row, { provider: "e2b", kind: "desktop", id: "c1", name: "c1", epoch: 3, until: T0 + KEEP_MS });
  await first.release();
  assert.deepEqual(deletes(one.account), [], "a release after the park lets nothing more go");

  one.clock.now = T0 + KEEP_MS - 1;
  const before = one.account.calls.length;
  const resumed = await one.claim(5, { hadComputer: async () => true, onConnected: (words) => void said.push(words) });
  const calls = one.account.calls.slice(before);
  assert.deepEqual(calls.filter(([verb]) => verb !== "attach"), [["connect", "c1"]], `no list (no older claim's let go), no create: ${JSON.stringify(calls)}`);
  assert.ok(calls.some(([verb, id]) => verb === "attach" && id === "c1"), "the kept one attached again");
  assert.deepEqual([resumed.replaced, resumed.made, resumed.keeps], [undefined, "desktop", "desktop"], "not replaced; still the run's own, kept again at a later park");
  assert.equal(said.length, 1);
  assert.equal(said[0].kept, true);
  assert.equal(computerReadyWords(said[0]), "The desktop is ready: Linux (amd64), from E2B. It's the same desktop, as the wait left it.");
  assert.equal(await readKept(one.store.settings, "run-1"), undefined, "its row taken by the resume");
  assert.equal(one.mounts.inherited, 1, "the earlier claim's mount credential is this claim's");
  await resumed.release();
  assert.deepEqual(deletes(one.account), ["c1"], "the run's end lets it go");
  assert.equal(one.mounts.revoked, 1);
});

test("a desktop resumed after 10 minutes is a new one: the kept one let go, said once with why", async () => {
  const one = await server();
  await (await one.claim(3)).park();
  one.clock.now = T0 + KEEP_MS;
  const said = [];
  const resumed = await one.claim(5, { hadComputer: async () => true, onConnected: (words) => void said.push(words) });
  assert.deepEqual(creates(one.account), ["c1", "c2"], "a new desktop");
  assert.deepEqual(deletes(one.account), ["c1"], "the kept one let go before it");
  assert.deepEqual(resumed.replaced, { kind: "desktop", folderKept: false, lapsed: true });
  assert.equal(computerReadyWords(said[0]), "The desktop is ready: Linux (amd64), from E2B. The desktop wasn't kept: 10 minutes passed. It's a new desktop: the one before is gone, with what was on it.");
  assert.equal(said.length, 1, "said once");
  await resumed.release();
});

test("the park's hold words and the timeout words name the kind and the 10 minutes", () => {
  assert.equal(computerKeptWords("desktop"), "The desktop is kept for 10 minutes while you decide.");
  assert.equal(computerKeptWords("phone"), "The phone is kept for 10 minutes while you decide.");
  assert.equal(KEEP_MS, 600_000);
});

test("a phone is kept and attached again within 10 minutes, as a desktop is", async () => {
  const one = await server({ setting: { kind: "phone", provider: "phone-harness" }, groups: PHONE_GROUPS, machine: "android", keys: { PHONE_HARNESS_API_KEY: "fake-test-key" } });
  const first = await one.claim(3);
  assert.equal(first.keeps, "phone");
  assert.equal(await first.park(), true);
  one.clock.now = T0 + 60_000;
  const resumed = await one.claim(5, { hadComputer: async () => true });
  assert.deepEqual(creates(one.account), ["c1"]);
  assert.equal(resumed.replaced, undefined);
  await resumed.release();
  assert.deepEqual(deletes(one.account), ["c1"]);
});

test("Mode 2: the kept desktop's Archil mount reads back under its own claim's epoch, and nothing new is minted", async () => {
  const one = await server({ mode: 2 });
  const first = await one.claim(3);
  assert.notEqual(one.account.computers.get("c1").mount, undefined, "the run's folder mounted");
  await first.park();
  const resumed = await one.claim(5, { hadComputer: async () => true });
  assert.equal(resumed.computer.kind, "desktop", "its mount check passed under epoch 3");
  assert.deepEqual(creates(one.account), ["c1"]);
  assert.equal(one.mounts.inherited, 1);
  assert.equal(one.mounts.revoked, 0, "nothing revoked while the run goes on");
  await resumed.release();
  assert.equal(one.mounts.revoked, 1, "revoked once, at the run's end");
});

test("a server's restart during the keep: the janitor's pass finds the kept desktop and leaves it within 10 minutes, a resume then still attaches it, and past them ends it", async () => {
  const one = await server();
  await (await one.claim(3)).park();
  // The parking process is gone; a new one's janitor reads the row.
  one.clock.now = T0 + 5 * 60_000;
  const early = await one.janitor();
  assert.deepEqual(early, { ended: [], failed: [], next: T0 + KEEP_MS }, "left, and woken again at its time");
  assert.deepEqual(deletes(one.account), []);
  const resumed = await one.claim(5, { hadComputer: async () => true });
  assert.deepEqual(creates(one.account), ["c1"], "still found");
  await resumed.park();

  // Kept again at that park, from its own time; nobody resumes: the janitor ends it at its time.
  const row = await readKept(one.store.settings, "run-1");
  assert.equal(row.until, one.clock.now + KEEP_MS);
  assert.equal(row.epoch, 3, "the epoch its labels carry");
  one.clock.now = row.until;
  const due = await one.janitor();
  assert.deepEqual(due, { ended: ["c1"], failed: [] });
  assert.deepEqual(deletes(one.account), ["c1"]);
  assert.equal((await readKept(one.store.settings, "run-1")).ended, true, "marked ended, for the resume to say why");

  const said = [];
  const late = await one.claim(7, { hadComputer: async () => true, onConnected: (words) => void said.push(words) });
  assert.deepEqual(late.replaced, { kind: "desktop", folderKept: false, lapsed: true });
  assert.match(computerReadyWords(said[0]), /The desktop wasn't kept: 10 minutes passed\. It's a new desktop/);
  await late.release();
});

test("a kept desktop whose run ended while parked (a stop, a cancel) is ended at the janitor's next pass, its row removed", async () => {
  const one = await server();
  await (await one.claim(3)).park();
  one.store.runs.set("run-1", "stopped");
  assert.deepEqual(await one.janitor(), { ended: ["c1"], failed: [] });
  assert.deepEqual(deletes(one.account), ["c1"]);
  assert.equal(one.store.settings.rows.has(keptKeyOf("run-1")), false);
});

test("a kept desktop the run's end already let go (run-end-computers.ts) has its row removed by the janitor's next pass, with nothing failed", async () => {
  const one = await server();
  await (await one.claim(3)).park();
  one.account.computers.delete("c1");
  one.store.runs.set("run-1", "stopped");
  assert.deepEqual(await one.janitor(), { ended: ["c1"], failed: [] });
  assert.equal(one.store.settings.rows.size, 0);
});

test("the keep's end and a resume never both have it: a row the resume took is not ended, and one ended is not attached", async () => {
  const one = await server();
  await (await one.claim(3)).park();
  const row = await readKept(one.store.settings, "run-1");
  const resumed = await one.claim(5, { hadComputer: async () => true });
  one.clock.now = T0 + KEEP_MS;
  const providerOf = async () => one.account.provider;
  assert.deepEqual(await sweepKept({ settings: one.store.settings, runs: one.store.runs, now: one.clock.now, providerOf }), { ended: [], failed: [] }, "nothing left to end");
  // The row as it was, put back: its end finds it no longer the row it read.
  assert.equal(await one.store.settings.replaceIf(keptKeyOf("run-1"), { ...row, ended: true }, row), false);
  await resumed.release();
});

test("a process that died after its end began, before the delete answered: the row reads ending, no resume takes it, and the janitor's next pass deletes it and marks it ended", async () => {
  const one = await server();
  await (await one.claim(3)).park();
  const row = await readKept(one.store.settings, "run-1");
  one.clock.now = row.until;
  // The parking process's end: its delete never answers (the process is gone).
  void endKept(one.store.settings, "run-1", row, () => new Promise(() => {}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readKept(one.store.settings, "run-1")).ending, true);
  assert.deepEqual(await one.janitor(), { ended: ["c1"], failed: [] }, "deleted again by the janitor");
  assert.deepEqual(deletes(one.account), ["c1"]);
  assert.equal((await readKept(one.store.settings, "run-1")).ended, true);
});

test("a kept computer's delete that hangs is bounded: the pass goes on to the next row, says it, and the next pass deletes it again", async () => {
  const one = await server();
  await (await one.claim(3)).park();
  // A second run's kept desktop, its run no longer in the store.
  one.account.computers.set("c9", { id: "c9", labels: {} });
  await writeKept(one.store.settings, "run-2", { provider: "e2b", kind: "desktop", id: "c9", name: "c9", epoch: 1, until: T0 + KEEP_MS });
  one.clock.now = T0 + KEEP_MS;
  let hang = true;
  const provider = { ...one.account.provider, release: (ref, how) => (hang && ref.id === "c1" ? new Promise(() => {}) : one.account.provider.release(ref, how)) };
  const pass = () => sweepKept({ settings: one.store.settings, runs: one.store.runs, now: one.clock.now, providerOf: async () => provider, deleteMs: 50 });
  const first = await pass();
  assert.deepEqual(first.ended, ["c9"], "the next row ended in the same pass");
  assert.equal(first.failed.length, 1);
  assert.match(first.failed[0], /^c1 of run run-1: its delete did not answer within 0\.05 s; the next pass tries again$/);
  assert.equal((await readKept(one.store.settings, "run-1")).ending, true, "left ending: no resume takes it");
  hang = false;
  assert.deepEqual(await pass(), { ended: ["c1"], failed: [] });
  assert.equal(one.account.computers.has("c1"), false);
});

test("the janitor's wake at a kept computer's time, come while a provider sweep runs, ends it as soon as that sweep is done", async () => {
  const root = scratch();
  const store = memoryStore();
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, "E2B_API_KEY", "fake-test-key");
  const account = vendor(root, DESKTOP_GROUPS);
  account.computers.set("c1", { id: "c1", labels: {} });
  await writeKept(store.settings, "run-1", { provider: "e2b", kind: "desktop", id: "c1", name: "c1", epoch: 3, until: Date.now() + 100 });
  // The provider sweep's list takes 2.5 s; the wake comes at about 1.1 s, while it runs.
  const slow = { ...account.provider, list: async (labels) => { await new Promise((resolve) => setTimeout(resolve, 2_500)); return account.provider.list(labels); } };
  const logged = [];
  const janitor = startJanitor({ store, computers: { kinds: KINDS, providers: { e2b: () => slow }, keyOf: (name) => getSealedKey(store, sealKey, name) }, env: {}, log: (line) => void logged.push(line), everyMs: 600_000 });
  try {
    for (let i = 0; i < 60 && account.computers.has("c1"); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(account.computers.has("c1"), false, `ended once the sweep was done: ${JSON.stringify(logged)}`);
    assert.equal((await readKept(store.settings, "run-1")).ended, true);
  } finally {
    await janitor.close();
  }
});

const SANDBOX = { setting: { kind: "sandbox", provider: "docker" }, groups: ["exec", "files", "processes"], keys: {} };

test("a sandbox parked and resumed within 10 minutes is the same sandbox: no create, a file outside the run folder still there, never called a new one", async () => {
  const one = await server(SANDBOX);
  const said = [];
  const first = await one.claim(3);
  assert.equal(first.keeps, "sandbox", "the claim's sandbox is one a park keeps");
  // What the run left in the sandbox outside its folder before the park (/tmp/outside-1), as the vendor's machine holds it.
  one.account.computers.get("c1").outside = "/tmp/outside-1";
  assert.equal(await first.park("approval"), true, "kept");
  assert.deepEqual(deletes(one.account), [], "nothing deleted at the park");
  assert.equal(one.mounts.revoked, 0);
  assert.deepEqual(await readKept(one.store.settings, "run-1"), { provider: "docker", kind: "sandbox", id: "c1", name: "c1", epoch: 3, until: T0 + KEEP_MS, folder: "bind" }, "the row says how it holds the run's folder");

  one.clock.now = T0 + 60_000;
  const resumed = await one.claim(5, { hadComputer: async () => true, onConnected: (words) => void said.push(words) });
  assert.deepEqual(creates(one.account), ["c1"], "no create");
  assert.equal(resumed.computer.kind, "sandbox");
  assert.deepEqual([resumed.replaced, resumed.keeps], [undefined, "sandbox"], "not replaced (no replaced line, no note); kept again at a later park");
  assert.equal(one.account.computers.get("c1").outside, "/tmp/outside-1", "the file outside the run folder is still there");
  assert.equal(said.length, 1);
  assert.equal(computerReadyWords(said[0]), "The sandbox is ready: Linux (amd64), from Docker. It's the same sandbox, as the wait left it.");
  await resumed.release();
  assert.deepEqual(deletes(one.account), ["c1"], "the run's end lets it go");
});

test("a sandbox resumed after 10 minutes is a new one: the kept one let go, said once with why, its note says what is gone", async () => {
  const one = await server(SANDBOX);
  await (await one.claim(3)).park("approval");
  one.clock.now = T0 + KEEP_MS;
  const said = [];
  const resumed = await one.claim(5, { hadComputer: async () => true, onConnected: (words) => void said.push(words) });
  assert.deepEqual(creates(one.account), ["c1", "c2"], "a new sandbox");
  assert.deepEqual(deletes(one.account), ["c1"], "the kept one let go before it");
  assert.deepEqual(resumed.replaced, { kind: "sandbox", folderKept: false, lapsed: true });
  assert.equal(said.length, 1, "said once");
  assert.equal(computerReadyWords(said[0]), "The sandbox is ready: Linux (amd64), from Docker. The sandbox wasn't kept: 10 minutes passed. It's a new sandbox: the one before is gone, with what was on it.");
  assert.equal(computerReplacedNote(resumed.replaced), "AgentRun server note: your computer was replaced. The earlier one is gone, with its files and processes. Check its files again before relying on them.");
  await resumed.release();
});

test("a server's restart during a sandbox's keep: the janitor leaves it within 10 minutes and ends it past them", async () => {
  const one = await server(SANDBOX);
  await (await one.claim(3)).park("answer");
  one.clock.now = T0 + 5 * 60_000;
  assert.deepEqual(await one.janitor(), { ended: [], failed: [], next: T0 + KEEP_MS });
  assert.deepEqual(deletes(one.account), []);
  one.clock.now = T0 + KEEP_MS;
  assert.deepEqual(await one.janitor(), { ended: ["c1"], failed: [] });
  assert.deepEqual(deletes(one.account), ["c1"]);
  assert.equal((await readKept(one.store.settings, "run-1")).ended, true);
});

test("a sandbox's park hold words and timeout words", () => {
  assert.equal(computerKeptWords("sandbox"), "The sandbox is kept for 10 minutes while you decide.");
  assert.equal(computerLapsedWords("sandbox"), "The sandbox wasn't kept: 10 minutes passed.");
});

/** A Mode 2 Daytona sandbox with no DAYTONA_ARCHIL_EGRESS (a synced folder), its run's folder on a fake disk. */
const RUN_ROOT = runKey("acme", "r1");
const text = (bytes) => (bytes === undefined ? undefined : Buffer.from(bytes).toString());
async function syncedServer() {
  const disk = new FakeArchilDisk();
  const one = await server({ setting: { kind: "sandbox", provider: "daytona" }, mode: 2, groups: ["exec", "files", "processes"], keys: { DAYTONA_API_KEY: "fake-test-key" }, workspace: archilWorkspace(disk, RUN_ROOT) });
  // The fake computer has no tar: a push into a new one is taken as landed (every computer of the account is one host
  // folder, which already holds what the disk does).
  const connect = one.account.provider.connect;
  one.account.provider.connect = async (ref) => {
    const connected = await connect(ref);
    if (!connected.ok) return connected;
    const client = connected.value.client;
    const call = (method, params, options) => (method.startsWith("tar.push.") ? Promise.resolve({ ok: true, value: method === "tar.push.begin" ? { id: "push-1" } : {} }) : client.call(method, params, options));
    return { ok: true, value: { ...connected.value, client: Object.assign(Object.create(client), { call }) } };
  };
  return { ...one, disk };
}

/** Real time until `done()` holds, for what runs after a mocked timer fired. */
async function until(done, what) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(done(), what);
}

test("a synced folder's park lands its delta on the disk before the computer is kept; its end at its time deletes it with no read-back, so what was written while kept is lost", async (t) => {
  const one = await syncedServer();
  const first = await one.claim(3);
  assert.equal(first.keeps, "sandbox");
  one.account.computer.plant.file("/workspace/before-park.log", "written before the park\n");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(await first.park("approval"), true, "kept");
    assert.equal(text(one.disk.files.get(`${RUN_ROOT}/before-park.log`)), "written before the park\n", "the park's delta landed");
    assert.equal((await readKept(one.store.settings, "run-1")).folder, "sync", "the row says it holds a synced folder");
    // A background program of the run's writes while it is kept: no call of the run's lands it.
    one.account.computer.plant.file("/workspace/while-kept.log", "written while kept\n");
    const before = one.account.calls.length;
    t.mock.timers.tick(KEEP_MS);
    t.mock.timers.reset();
    await until(() => deletes(one.account).includes("c1"), "deleted at its time");
    assert.equal(one.disk.files.has(`${RUN_ROOT}/while-kept.log`), false, "no read-back before the delete");
    const after = one.account.calls.slice(before).map(([verb, , how]) => (how ? `${verb} ${how}` : verb));
    assert.deepEqual(after, ["release delete"], "the delete alone, as the janitor's");
    assert.equal(one.mounts.revoked, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("a synced folder's park whose delta does not land keeps nothing: the computer goes as at the run's end, saying writes may be lost, no row", async () => {
  const one = await syncedServer();
  const first = await one.claim(3);
  one.account.computer.plant.file("/workspace/late.log", "x");
  one.disk.putObject = async () => { throw new FakeDiskError(503, "ServiceUnavailable", "the disk is away"); };
  await assert.rejects(first.park("approval"), /^Error: the run's folder was not let go cleanly: the final sync failed \(.*late\.log: .*the disk is away\), so writes since the last sync may be lost$/, "not kept; the runner logs why");
  assert.deepEqual(deletes(one.account), ["c1"]);
  assert.equal(await readKept(one.store.settings, "run-1"), undefined);
  assert.equal(one.mounts.revoked, 1);
});

test("a runner that lost its claim has its writes to the run's folder refused by the claim epoch: once runner B holds the run, nothing runner A sends reaches the disk, and B's writes land", async () => {
  const one = await syncedServer();
  const writes = () => one.disk.calls.filter(({ op }) => op === "putObject" || op === "deleteObject" || op === "appendObject").length;
  const a = await one.claim(1);
  const aClient = a.computer.computer.client;
  one.account.computer.plant.file("/workspace/a1.txt", "A, holding the claim\n");
  assert.equal((await aClient.call("files.mkdir", { path: "/workspace/d1" })).ok, true);
  assert.equal(text(one.disk.files.get(`${RUN_ROOT}/a1.txt`)), "A, holding the claim\n");

  // Runner B claims the run at epoch 2; runner A goes on, not knowing yet.
  const b = await one.claim(2);
  const before = writes();
  one.account.computer.plant.file("/workspace/a2.txt", "A, after B's claim\n");
  const late = await aClient.call("files.mkdir", { path: "/workspace/d2" });
  assert.equal(late.ok, false, "A's call answers that its folder was not made durable");
  assert.match(late.error.message, /^files\.mkdir ran, but the run's folder could not be made durable: .*this runner no longer holds the run's claim/);
  assert.equal(writes(), before, "nothing A sent reached the disk");
  assert.equal(one.disk.files.has(`${RUN_ROOT}/a2.txt`), false);
  assert.equal(one.disk.dirs.has(`${RUN_ROOT}/d2`), false);
  // A's release: its final delta is refused too (its computer, which B's claim let go, is gone already).
  await a.release().catch(() => undefined);
  assert.equal(writes(), before, "nothing of A's final delta reached the disk");

  // B's writes land.
  one.account.computer.plant.file("/workspace/b.txt", "B\n");
  assert.equal((await b.computer.computer.client.call("files.mkdir", { path: "/workspace/d3" })).ok, true);
  assert.equal(text(one.disk.files.get(`${RUN_ROOT}/b.txt`)), "B\n");
  assert.equal(one.disk.dirs.has(`${RUN_ROOT}/d3`), true);
  await b.release();

  // B's run ends (its end commit: the epoch up by one, no runner), so no claim holds the run: A is still refused.
  one.store.runs.end("run-1");
  const after = writes();
  one.account.computer.plant.file("/workspace/a3.txt", "A, after B's end\n");
  const later = await aClient.call("files.mkdir", { path: "/workspace/d4" });
  assert.equal(later.ok, false, "a run that a later claim ended is not A's again");
  assert.match(later.error.message, /this runner no longer holds the run's claim/);
  assert.equal(writes(), after);
  assert.equal(one.disk.files.has(`${RUN_ROOT}/a3.txt`), false);
});

test("a claim's own end or park lets its final writes through: the epoch one past its own with no runner is still the claim's", async () => {
  const one = await syncedServer();
  const a = await one.claim(4);
  // The adapter loop's end commit lands before the final delta: the epoch up by one, no runner.
  one.store.runs.end("run-1");
  one.account.computer.plant.file("/workspace/last.txt", "written after the end commit\n");
  await a.release();
  assert.equal(text(one.disk.files.get(`${RUN_ROOT}/last.txt`)), "written after the end commit\n");
});

test("a kept computer holding the run's folder another way is not taken back: as any kind or provider mismatch, the claim's launch deletes it as an older claim's and makes a new one, its row and mount token left to its keep's end", async () => {
  const one = await syncedServer();
  const made = await one.account.provider.create({ labels: { "agentrun.run": "run-1", "agentrun.epoch": "3" }, mount: { kind: "archil", disk: "dsk-1", region: "aws-us-east-1", folder: "acme/r1/work" } });
  await writeKept(one.store.settings, "run-1", { provider: "daytona", kind: "sandbox", id: made.value.id, name: made.value.name, epoch: 3, until: T0 + KEEP_MS, folder: "archil" });
  const resumed = await one.claim(5, { hadComputer: async () => true });
  assert.deepEqual(creates(one.account), ["c1", "c2"], "a new sandbox");
  assert.deepEqual(deletes(one.account), ["c1"], "the kept one deleted, never attached");
  assert.equal(one.account.calls.some(([verb, id]) => verb === "attach" && id === "c1"), false);
  assert.deepEqual([one.mounts.inherited, one.mounts.revoked], [0, 0], "its Archil token is still the parking claim's");
  assert.equal((await readKept(one.store.settings, "run-1")).id, "c1", "its row is left to its keep's end");
  assert.equal(resumed.computer.kind, "sandbox");
  await resumed.release();
});

test("a park closes the desktop's live view with what the run waits for and until when it is kept, never `ended`", async () => {
  for (const cause of ["approval", "answer", "cap", "refusal", "workflow"]) {
    const one = await server();
    const closes = [];
    const openComputerView = async () => ({ ok: true, view: { close: (why) => void closes.push(why) } });
    const first = await one.claim(3, { openComputerView });
    assert.equal(await first.park(cause), true);
    assert.deepEqual(closes, [{ parked: cause, until: T0 + KEEP_MS }], cause);
    await first.release();
    assert.equal(closes.length, 1, "the release after the park closes nothing more");
  }
});

test("a paired computer and --faux's desktop are never kept: their park lets them go as the run's end does", async () => {
  const faux = fauxComputers();
  const store = memoryStore();
  const fauxDesk = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "desktop", provider: "faux-desktop" } }, store, { mode: 1, kinds: faux.kinds, keyTable: faux.keyTable, launch: faux.launch, providers: {}, spec: () => ({ image: "faux", lifetimeMs: 60_000, network: "open" }), check: { readBackOf }, workspace: localWorkspace(scratch()) });
  assert.equal(fauxDesk.keeps, undefined, "--faux's desktop");
  assert.equal(await fauxDesk.park(), false);
  assert.equal(store.settings.rows.size, 0);

  const driver = new FakeUiDriver({ groups: ["screen", "input.pointer", "input.keys", "apps", "ui"] });
  const row = { id: "c-1", name: "Test Mac", hello: driver.hello(), driver: "0", labels: { owner: "test" }, pairingId: "p-1", createdAt: 0, seenAt: 0, revokedAt: null };
  const hub = new AttachHub();
  const [served, computer] = socketPair();
  serveUiSocket(driver, computer);
  assert.equal((await hub.accept(pairedOf(row), served)).ok, true);
  try {
    const pairedStore = memoryStore();
    const held = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "desktop", provider: row.id } }, pairedStore, { mode: 1, kinds: KINDS, sealKey: randomBytes(32), providers: {}, spec: () => ({ image: "attached", lifetimeMs: 60_000, network: "open" }), check: { readBackOf, epoch: 3 }, workspace: localWorkspace(scratch()), attached: { rows: async () => [row], hub } });
    assert.equal(held.keeps, undefined, "a paired computer");
    assert.equal(await held.park(), false);
    assert.equal(pairedStore.settings.rows.size, 0);
  } finally {
    driver.close();
  }
});

function socketPair() {
  const ends = [{ text: [], closes: [] }, { text: [], closes: [] }];
  let closed;
  const side = (me, peer) => ({
    send(text) { if (!closed) queueMicrotask(() => peer.text.forEach((listener) => listener(text))); },
    close(code, reason) {
      if (closed) return;
      closed = { code, reason };
      queueMicrotask(() => [...me.closes, ...peer.closes].forEach((listener) => listener(code, reason)));
    },
    onText(listener) { me.text.push(listener); },
    onClose(listener) { me.closes.push(listener); },
    get closed() { return closed; },
  });
  return [side(ends[0], ends[1]), side(ends[1], ends[0])];
}
