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
import { archilClaim, archilWorkspace, computerForClaim, localWorkspace, runKey } from "../dist/workspace/index.js";
import { FakeArchilDisk, FakeDiskError } from "./fixtures/archil-fake.mjs";
import { pairedOf } from "../dist/workspace/attached-computers.js";
import { fauxComputers } from "../dist/faux-computers.js";
import { computerKeptWords, computerReadyWords, computerReplacedNote } from "../dist/workspace/computer-deps.js";
import { computerLapsedWords, endKept, KEEP_MS, KEPT_DELETE_MS, keptKeyOf, readKept, sweepKept, writeKept } from "../dist/workspace/computer-kept.js";
import { startJanitor, sweepKeptComputers } from "../dist/workspace/computer-janitor.js";
import { ARCHIL_API_KEY_ROW, agentDiskKey, clearArchilSettings, saveArchilSettings } from "../dist/archil-settings.js";
import { MOUNT_TTL_MS } from "../dist/workspace/archil-claim.js";
import { StoreLaunchMissing } from "../dist/store/index.js";
import { computerStillOffWords } from "../dist/refusal-words.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { memoryIntervals } from "./memory-intervals.mjs";
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
  const runs = new Map([["run-1", { id: "run-1", agentId: "agent-1", state: "parked", epoch: 0, runner: null }]]);
  return {
    // `take`: a runner's claim of the run, at `epoch` (the store's claim moves the epoch up and names the runner); `end`:
    // its end, park or release commit (the epoch up by one, no runner). No run has a launch record: its Archil disk is its
    // agent's.
    runs: {
      get: async (id) => runs.get(id),
      launch: async (id) => { throw new StoreLaunchMissing(id); },
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
    computerIntervals: memoryIntervals(),
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
/** The agent's Archil disk, where run-1's folder and its mount credentials are. */
const DISK = "dsk-0000000000000001";

/** Archil's control plane holding token users on the run's disk, by nickname (archil-mount-credential.ts nicknameOf):
 *  run-1's of claim epochs 1 and 3 (the parking claim's), a later claim's of run-1, and another run's. */
const mountUsers = () => archilControlFetch({ existing: ["agentrun:run-1:1", "agentrun:run-1:3", "agentrun:run-1:6", "agentrun:run-2:3"].map((nickname, n) => ({ type: "token", identifier: `tok-${n}`, nickname, disk: DISK })) });
/** The token users' nicknames still at Archil. */
const nicknames = (archil) => [...archil.users.values()].map((user) => user.nickname).sort();

/** One server: its store, a vendor's account, a clock, and its claims of run-1 (each a claim at `epoch`). `archil`: the
 *  fake of Archil's control plane (archilControlFetch) its janitor reaches, with the server's Archil settings, its sealed
 *  account key and the agent's disk saved. */
async function server({ setting = E2B_DESKTOP, mode = 1, groups = DESKTOP_GROUPS, machine, keys = { E2B_API_KEY: "fake-test-key" }, workspace, archil } = {}) {
  const root = scratch();
  const store = memoryStore();
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, sealKey, name, value);
  if (archil) {
    await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
    await putSealedKey(store, sealKey, ARCHIL_API_KEY_ROW, "fake-test-key");
    await store.settings.put(agentDiskKey("agent-1"), { diskId: DISK });
  }
  const mountControl = archil ? { mountControl: { baseUrl: archil.baseUrl, fetch: archil.fetch } } : {};
  const account = vendor(root, groups, machine);
  const clock = { now: T0 };
  const providers = Object.fromEntries(["docker", "e2b", "agent37", "phone-harness", "daytona"].map((id) => [id, () => account.provider]));
  const mounts = { revoked: 0, inherited: 0, steps: [] };
  const deps = { mode, kinds: KINDS, sealKey, providers, spec: SPEC, workspace: workspace ?? localWorkspace(root), revokeMount: async () => void (mounts.revoked += 1, mounts.steps.push("revoke")), inheritMount: () => void (mounts.inherited += 1, mounts.steps.push("inherit")), now: () => clock.now };
  // `launch`: more of the claim's launch (its `holder`: the runner that claims and its incarnation).
  const claim = (epoch, extra = {}, launch = {}) => {
    store.runs.take("run-1", epoch);
    return computerForClaim({ runId: "run-1", epoch, computer: setting, ...launch }, store, { ...deps, check: { readBackOf, epoch }, ...extra });
  };
  // `self` and `runners`: the janitor of a runner (its name and incarnation), reading which runners are there.
  const janitor = ({ self, runners } = {}) => sweepKeptComputers({ store: runners ? { ...store, runners } : store, computers: { kinds: KINDS, providers, keyOf: (name) => getSealedKey(store, sealKey, name) }, env: {}, sealKey, ...mountControl, now: () => clock.now, ...(self ? { self } : {}) });
  // A full janitor pass as the runner process runs it (startJanitor's first: the kept pass, then every provider's sweep),
  // as runner `self` reading `runners`; one vendor account behind every provider, as a dial vendor's (or one Docker
  // engine) both runners list. The store without its agents, so no server id is minted. What it logged.
  const pass = async ({ self, runners } = {}) => {
    const logged = [];
    const swept = { runs: store.runs, computerLedger: store.computerLedger, settings: store.settings, sealedKeys: store.sealedKeys, computerIntervals: store.computerIntervals, ...(runners ? { runners } : {}) };
    const running = startJanitor({ store: swept, computers: { kinds: KINDS, providers, keyOf: (name) => getSealedKey(store, sealKey, name) }, env: {}, sealKey, ...mountControl, log: (line) => void logged.push(line), everyMs: 600_000, now: () => clock.now, ...(self ? { self } : {}) });
    try {
      await running.first;
    } finally {
      await running.close();
    }
    return logged;
  };
  return { store, account, clock, mounts, claim, janitor, pass, sealKey, keys };
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

test("Mode 2, a resume of a run whose desktop an earlier claim's deny turned off: the desktop its park kept is deleted and its mount revoked at once, so the run's folder is its own again, and the claim goes on with none", async () => {
  const one = await server({ mode: 2 });
  await (await one.claim(3)).park();
  const said = [];
  const resumed = await one.claim(5, { turnedOff: "desktop", hadComputer: async () => true, onComputerNote: (words) => void said.push(words) });
  assert.deepEqual([resumed.computer, resumed.off], [undefined, true], "the claim has no computer");
  assert.deepEqual(creates(one.account), ["c1"], "none made");
  assert.deepEqual(deletes(one.account), ["c1"], "the kept desktop deleted now, not at the end of its 10 minutes");
  // archil-claim.ts revoke removes only a credential its claim minted or took on: the parking claim's is taken on first.
  assert.deepEqual(one.mounts.steps, ["inherit", "revoke"], "its mount credential taken on, then revoked");
  assert.equal((await readKept(one.store.settings, "run-1"))?.ended, true, "its row ended: nothing left for the janitor");
  assert.deepEqual(said, [computerStillOffWords("desktop")]);
  await resumed.release();
  assert.deepEqual(deletes(one.account), ["c1"], "the run's end lets nothing more go");
});

test("a claim of a run whose desktop is off, with nothing kept: none is made, nothing deleted or revoked", async () => {
  const one = await server({ mode: 2 });
  const resumed = await one.claim(5, { turnedOff: "desktop", hadComputer: async () => true });
  assert.deepEqual([resumed.computer, resumed.off], [undefined, true]);
  assert.deepEqual([creates(one.account), deletes(one.account), one.mounts.steps], [[], [], []]);
});

/** A mount revoke that never answers until let go (Archil not answering): its `called` settles when it is asked. */
function hangingRevoke() {
  let asked;
  let letGo;
  const called = new Promise((done) => { asked = done; });
  const answered = new Promise((done) => { letGo = done; });
  return { called, letGo: () => letGo(), revokeMount: () => { asked(); return answered; } };
}

test("Mode 2, a resume of a run whose desktop is off, its kept desktop's mount revoke not answering: the claim goes on after KEPT_DELETE_MS, the row left ending for the janitor", async (t) => {
  const one = await server({ mode: 2 });
  await (await one.claim(3)).park();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const revoke = hangingRevoke();
  const claimed = one.claim(5, { turnedOff: "desktop", hadComputer: async () => true, revokeMount: revoke.revokeMount });
  await revoke.called;
  t.mock.timers.tick(KEPT_DELETE_MS);
  const resumed = await claimed;
  assert.deepEqual([resumed.computer, resumed.off], [undefined, true]);
  assert.deepEqual(deletes(one.account), ["c1"], "the desktop deleted all the same");
  assert.equal((await readKept(one.store.settings, "run-1"))?.ending, true, "its row left ending");
  revoke.letGo();
});

test("Mode 2, a resume of a run whose desktop is off, stopped while its kept desktop's mount revoke does not answer: the claim goes on at the stop", async () => {
  const one = await server({ mode: 2 });
  await (await one.claim(3)).park();
  const revoke = hangingRevoke();
  const stop = new AbortController();
  const claimed = one.claim(5, { turnedOff: "desktop", hadComputer: async () => true, revokeMount: revoke.revokeMount, signal: stop.signal });
  await revoke.called;
  stop.abort();
  const resumed = await claimed;
  assert.deepEqual([resumed.computer, resumed.off], [undefined, true]);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ending, true, "its row left ending");
  revoke.letGo();
});

/** A claim's Archil mount credentials as archil-claim.ts holds them, over the run's `tokens` (by the epoch that minted
 *  each): its revoke removes the run's tokens of its epoch and earlier only once it took one on (inherit). */
function archilClaimOf(tokens, epoch) {
  let inherited = false;
  return {
    inheritMount: () => { inherited = true; },
    revokeMount: async () => {
      if (!inherited) return;
      inherited = false;
      for (const token of [...tokens]) if (token <= epoch) tokens.delete(token);
    },
  };
}

test("Mode 2, a claim whose desktop is off loses its park's kept desktop to a later claim that takes it back: it never takes on the mount credential, so its loss's revoke leaves the later claim's mount in place", async () => {
  const one = await server({ mode: 2 });
  await (await one.claim(3)).park();
  const tokens = new Set([3]);
  const [b, c] = [archilClaimOf(tokens, 5), archilClaimOf(tokens, 6)];
  // Claim 6 (its tools allowed again) takes the kept desktop back between claim 5's read of the row and its end of it.
  const replaceIf = one.store.settings.replaceIf.bind(one.store.settings);
  let later;
  one.store.settings.replaceIf = async (key, ...rest) => {
    if (key === keptKeyOf("run-1") && !later) later = await one.claim(6, { hadComputer: async () => true, ...c });
    return replaceIf(key, ...rest);
  };
  const off = await one.claim(5, { turnedOff: "desktop", hadComputer: async () => true, ...b });
  assert.deepEqual([off.computer, off.off], [undefined, true]);
  assert.equal(later?.made, "desktop", "claim 6 took the kept desktop back");
  assert.deepEqual(deletes(one.account), [], "nothing deleted");
  // Claim 5 lost: archil-claim.ts lost() revokes.
  await b.revokeMount();
  assert.deepEqual([...tokens], [3], "the mount credential claim 6's desktop holds stands");
  await later.release();
});

test("Mode 2, a claim whose desktop is off finds its park's kept desktop ended: nothing taken on or revoked, as whatever ended it removed its credential", async () => {
  const one = await server({ mode: 2 });
  await (await one.claim(3)).park();
  const row = await readKept(one.store.settings, "run-1");
  assert.equal(row?.folder, "archil");
  await endKept(one.store.settings, "run-1", row, async () => {});
  const off = await one.claim(5, { turnedOff: "desktop", hadComputer: async () => true });
  assert.deepEqual([off.computer, off.off], [undefined, true]);
  assert.deepEqual(one.mounts.steps, [], "no credential to take on");
});

test("Mode 2, a run stopped while parked, its parking runner gone: the janitor's pass deletes the kept desktop and removes the run's mount credentials up to the parking claim's epoch at Archil, by name, with the server's key", async () => {
  const archil = mountUsers();
  const one = await server({ mode: 2, archil });
  await (await one.claim(3)).park();
  assert.equal((await readKept(one.store.settings, "run-1"))?.folder, "archil", "its row says the desktop holds the run's folder on Archil");
  // The stop's claim ends the run with no loop and never takes the row (computer-kept.ts); the runner that parked it is gone.
  one.store.runs.set("run-1", "stopped");
  const logged = await one.pass();
  assert.deepEqual(logged.filter((line) => line.includes("could not")), [], logged.join("\n"));
  assert.deepEqual(deletes(one.account), ["c1"]);
  assert.equal(await readKept(one.store.settings, "run-1"), undefined, "its row removed");
  assert.deepEqual(nicknames(archil), ["agentrun:run-1:6", "agentrun:run-2:3"], "the parking claim's credential and an earlier one's removed now, not left for their 24-hour ttl; a later claim's and another run's stand");
  assert.ok(archil.requests.every((request) => request.authorization === "Bearer fake-test-key"), "with the server's saved Archil key");
});

test("Mode 2, a resume whose computer setting is none leaves the park's kept desktop to its time; the janitor that ends it then removes the parking claim's mount credential", async () => {
  const archil = mountUsers();
  const one = await server({ mode: 2, archil });
  await (await one.claim(3)).park();
  const resumed = await one.claim(5, { hadComputer: async () => true }, { computer: { kind: "none" } });
  assert.equal(resumed.computer, undefined);
  assert.deepEqual(one.mounts.steps, [], "the resume took nothing on");
  assert.equal((await readKept(one.store.settings, "run-1"))?.ended, undefined, "its row is left to its time");
  one.clock.now = T0 + KEEP_MS;
  const swept = await one.janitor();
  assert.deepEqual([swept.ended, swept.failed], [["c1"], []]);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ended, true);
  assert.deepEqual(nicknames(archil), ["agentrun:run-1:6", "agentrun:run-2:3"], "the parking claim's credential removed with its desktop");
});

test("Mode 2, a claim that began a kept desktop's end and died before its delete: the janitor's next pass deletes it and removes the parking claim's mount credential", async () => {
  const archil = mountUsers();
  const one = await server({ mode: 2, archil });
  await (await one.claim(3)).park();
  const row = await readKept(one.store.settings, "run-1");
  await assert.rejects(endKept(one.store.settings, "run-1", row, async () => { throw new Error("the runner died"); }));
  const swept = await one.janitor();
  assert.deepEqual([swept.ended, swept.failed], [["c1"], []]);
  assert.deepEqual(nicknames(archil), ["agentrun:run-1:6", "agentrun:run-2:3"]);
});

test("Mode 2, the janitor's pass whose mount remove Archil refuses: the kept desktop is deleted, the row left ending and said, and the next pass removes it", async () => {
  let refuse = true;
  const archil = archilControlFetch({
    existing: [{ type: "token", identifier: "tok-3", nickname: "agentrun:run-1:3", disk: DISK }],
    answer: ({ method }) => (refuse && method === "DELETE" ? { status: 500, body: { error: "Archil is down" } } : undefined),
  });
  const one = await server({ mode: 2, archil });
  await (await one.claim(3)).park();
  one.store.runs.set("run-1", "stopped");
  const first = await one.janitor();
  assert.deepEqual(first.ended, []);
  assert.equal(first.failed.length, 1);
  assert.match(first.failed[0], /Archil is down/);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ending, true, "left ending for the next pass");
  assert.deepEqual(nicknames(archil), ["agentrun:run-1:3"]);
  refuse = false;
  const second = await one.janitor();
  assert.deepEqual([second.ended, second.failed], [["c1"], []]);
  assert.equal(await readKept(one.store.settings, "run-1"), undefined, "its row removed");
  assert.deepEqual(nicknames(archil), []);
});

test("Mode 2, a stopped run's kept desktop whose mount remove Archil refuses for good: the row stays ending until the credential's ttl is past its keep, then the janitor's next pass ends it and removes the row with no call to Archil", async () => {
  const archil = archilControlFetch({
    existing: [{ type: "token", identifier: "tok-3", nickname: "agentrun:run-1:3", disk: DISK }],
    answer: ({ method }) => (method === "DELETE" ? { status: 403, body: { error: "not allowed" } } : undefined),
  });
  const one = await server({ mode: 2, archil });
  await (await one.claim(3)).park();
  const { until } = await readKept(one.store.settings, "run-1");
  one.store.runs.set("run-1", "stopped");
  const first = await one.janitor();
  assert.deepEqual(first.ended, []);
  assert.match(first.failed.join("\n"), /not allowed/);
  one.clock.now = until + MOUNT_TTL_MS - 1;
  const before = await one.janitor();
  assert.deepEqual(before.ended, [], "a credential minted before the park may still be live: its remove is still asked");
  assert.match(before.failed.join("\n"), /not allowed/);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ending, true, "left ending");
  one.clock.now = until + MOUNT_TTL_MS;
  const asked = archil.requests.length;
  const past = await one.janitor();
  assert.deepEqual([past.ended, past.failed], [["c1"], []]);
  assert.deepEqual(archil.requests.slice(asked), [], "no remove asked: the credential has ended at its ttl");
  assert.equal(await readKept(one.store.settings, "run-1"), undefined, "its row removed");
});

test("Mode 2, a kept desktop's row left ending with this server's Archil settings gone: the janitor says why until the credential's ttl is past its keep, then ends the row with no call to Archil", async () => {
  const archil = mountUsers();
  const one = await server({ mode: 2, archil });
  await (await one.claim(3)).park();
  const { until } = await readKept(one.store.settings, "run-1");
  await clearArchilSettings(one.store);
  one.clock.now = until;
  const first = await one.janitor();
  assert.deepEqual(first.ended, []);
  assert.match(first.failed.join("\n"), /Archil settings are gone/);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ending, true, "left ending");
  one.clock.now = until + MOUNT_TTL_MS - 1;
  assert.match((await one.janitor()).failed.join("\n"), /Archil settings are gone/);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ending, true, "still ending");
  one.clock.now = until + MOUNT_TTL_MS;
  const past = await one.janitor();
  assert.deepEqual([past.ended, past.failed], [["c1"], []]);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ended, true, "marked ended");
  assert.deepEqual(archil.requests, []);
});

test("a kept desktop whose folder is not on Archil: the janitor ends it with no call to Archil", async () => {
  const archil = mountUsers();
  const one = await server({ archil });
  await (await one.claim(3)).park();
  assert.notEqual((await readKept(one.store.settings, "run-1"))?.folder, "archil");
  one.store.runs.set("run-1", "stopped");
  const swept = await one.janitor();
  assert.deepEqual([swept.ended, swept.failed], [["c1"], []]);
  assert.deepEqual(archil.requests, []);
});

/** A claim's own Archil step, as archil-claim.ts makes it, for `one`'s run-1 at `epoch`, over the fake `archil`. */
const archilStepOf = (one, archil, epoch) =>
  archilClaim({
    settings: { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" },
    keys: one.store.sealedKeys,
    sealKey: one.sealKey,
    signal: new AbortController().signal,
    mount: { runId: "run-1", epoch, ttlMs: 86_400_000 },
    control: { baseUrl: archil.baseUrl, fetch: archil.fetch },
    run: { agentId: "agent-1", store: one.store },
    makeDisk: (options) => ({ id: options.disk }),
  });

test("Mode 2, the parking runner's own timer deletes the kept desktop and Archil refuses its mount credential's remove: the row is left ending and said, and the janitor's next pass removes the credential", async (t) => {
  let refuse = true;
  const archil = archilControlFetch({ answer: ({ method }) => (refuse && method === "DELETE" ? { status: 500, body: { error: "Archil is down" } } : undefined) });
  const one = await server({ mode: 2, archil });
  // The parking claim's own Archil step: its mount credential minted at epoch 3.
  const mount = await archilStepOf(one, archil, 3);
  await mount.token();
  assert.deepEqual(nicknames(archil), ["agentrun:run-1:3"]);
  // The timer's revoke, settled: what the timer does after it is the store's in memory, done within a few turns.
  let revoked;
  const logged = [];
  const first = await one.claim(3, { revokeMount: () => (revoked = mount.revoke()), inheritMount: () => mount.inherit(), log: (line) => void logged.push(line) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(await first.park("approval"), true, "kept");
    t.mock.timers.tick(KEEP_MS);
  } finally {
    t.mock.timers.reset();
  }
  await revoked?.catch(() => undefined);
  for (let turn = 0; turn < 10; turn += 1) await new Promise((done) => setImmediate(done));
  assert.deepEqual(deletes(one.account), ["c1"], "the timer deleted it");
  refuse = false;
  one.clock.now = T0 + KEEP_MS;
  const swept = await one.janitor();
  assert.deepEqual(nicknames(archil), [], "the parking claim's credential removed by the janitor's pass, not left for its 24-hour ttl");
  assert.deepEqual([swept.ended, swept.failed], [["c1"], []]);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ended, true);
  assert.equal(logged.filter((line) => line.includes("Archil is down")).length, 1, `the timer's failure said: ${JSON.stringify(logged)}`);
});

test("Mode 2, a resume that took the parked desktop and its mount credential parks again; its timer deletes the desktop and Archil refuses the credential's remove: the row is left ending and said, and the janitor's next pass removes the credential", async (t) => {
  let refuse = false;
  const archil = archilControlFetch({ answer: ({ method }) => (refuse && method === "DELETE" ? { status: 500, body: { error: "Archil is down" } } : undefined) });
  const one = await server({ mode: 2, archil });
  // Epoch 3 mints its credential and parks, the desktop kept.
  const parked = await archilStepOf(one, archil, 3);
  await parked.token();
  await (await one.claim(3, { revokeMount: () => parked.revoke(), inheritMount: () => parked.inherit() })).park("approval");
  // Epoch 5 takes the desktop back and, with it, epoch 3's credential: it mints none of its own.
  one.clock.now = T0 + 1;
  const taken = await archilStepOf(one, archil, 5);
  let revoked;
  const logged = [];
  const resumed = await one.claim(5, { hadComputer: async () => true, revokeMount: () => (revoked = taken.revoke()), inheritMount: () => taken.inherit(), log: (line) => void logged.push(line) });
  assert.equal(resumed.replaced, undefined, "the kept desktop attached again");
  assert.deepEqual(nicknames(archil), ["agentrun:run-1:3"], "nothing new minted");
  refuse = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(await resumed.park("approval"), true, "kept again");
    t.mock.timers.tick(KEEP_MS);
  } finally {
    t.mock.timers.reset();
  }
  await revoked?.catch(() => undefined);
  for (let turn = 0; turn < 10; turn += 1) await new Promise((done) => setImmediate(done));
  assert.deepEqual(deletes(one.account), ["c1"], "the timer deleted it");
  const row = await readKept(one.store.settings, "run-1");
  // The epoch its labels carry: the claim that made it, so the janitor's remove reaches the credential taken on.
  assert.deepEqual([row?.epoch, row?.ending, row?.ended], [3, true, undefined], "left ending: the janitor's to finish");
  refuse = false;
  one.clock.now = T0 + 1 + KEEP_MS;
  const swept = await one.janitor();
  assert.deepEqual(nicknames(archil), [], "the taken-on credential removed by the janitor's pass, not left for its 24-hour ttl");
  assert.deepEqual([swept.ended, swept.failed], [["c1"], []]);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ended, true);
  assert.equal(logged.filter((line) => line.includes("Archil is down")).length, 1, `the timer's failure said: ${JSON.stringify(logged)}`);
});

test("Mode 2, a resume of a run whose desktop is off, Archil refusing the remove of the credential it took on: the kept desktop deleted, the claim goes on, the row left ending, and the janitor's next pass removes the credential", async () => {
  let refuse = false;
  const archil = archilControlFetch({ answer: ({ method }) => (refuse && method === "DELETE" ? { status: 500, body: { error: "Archil is down" } } : undefined) });
  const one = await server({ mode: 2, archil });
  const parked = await archilStepOf(one, archil, 3);
  await parked.token();
  await (await one.claim(3, { revokeMount: () => parked.revoke(), inheritMount: () => parked.inherit() })).park("approval");
  refuse = true;
  const taken = await archilStepOf(one, archil, 5);
  const resumed = await one.claim(5, { turnedOff: "desktop", hadComputer: async () => true, revokeMount: () => taken.revoke(), inheritMount: () => taken.inherit() });
  assert.deepEqual([resumed.computer, resumed.off], [undefined, true], "the claim goes on with none");
  assert.deepEqual(deletes(one.account), ["c1"], "the kept desktop deleted all the same");
  assert.deepEqual(nicknames(archil), ["agentrun:run-1:3"], "still at Archil");
  const row = await readKept(one.store.settings, "run-1");
  assert.deepEqual([row?.ending, row?.ended], [true, undefined], "left ending: the janitor's to finish");
  refuse = false;
  one.clock.now = T0 + KEEP_MS;
  const swept = await one.janitor();
  assert.deepEqual(nicknames(archil), [], "the taken-on credential removed by the janitor's pass, not left for its 24-hour ttl");
  assert.deepEqual([swept.ended, swept.failed], [["c1"], []]);
  assert.equal((await readKept(one.store.settings, "run-1"))?.ended, true);
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

// Claim affinity (computer-kept.ts pinnedOf): a Docker computer is on the claiming runner's engine, so its park names
// that runner and its incarnation on the row; the store's claim rule then gives the run to that runner alone while it is
// there (store-claim-affinity.test.mjs, runner-claim-affinity.test.mjs).
const RUNNER_A = { runner: "runner-a", incarnation: "inc-a" };
const RUNNER_B = { runner: "runner-b", incarnation: "inc-b" };

test("leak (b): another runner's janitor leaves a kept row pinned to a runner still there, whatever its time; that runner's own janitor ends it, and once it is gone any janitor does", async () => {
  const one = await server(SANDBOX);
  await (await one.claim(3, {}, { holder: RUNNER_A })).park("approval");
  const key = keptKeyOf("run-1");
  // As this build's park writes it; put raw, so a janitor with no pin rule fails on its own pass alone.
  const row = { ...(await one.store.settings.get(key)), ...RUNNER_A };
  await one.store.settings.put(key, row);
  const live = [{ ...RUNNER_A, refused: null }];
  const runners = { live: async () => live };
  one.clock.now = T0 + KEEP_MS + 60_000;
  // runner-b's janitor: only runner-a's engine has the container, so a delete from here finds nothing, reads as done,
  // marks the row ended, and runner-a's own timer then finds it ended and deletes nothing: the container leaks.
  assert.deepEqual(await one.janitor({ self: RUNNER_B, runners }), { ended: [], failed: [] }, "runner-b's janitor leaves runner-a's row");
  assert.deepEqual(deletes(one.account), [], "nothing deleted from runner-b");
  assert.deepEqual(await one.store.settings.get(key), row, "the row as runner-a's park left it");
  assert.deepEqual(await one.janitor({ self: RUNNER_A, runners }), { ended: ["c1"], failed: [] }, "runner-a's own janitor ends it at its time");
  assert.deepEqual(deletes(one.account), ["c1"]);

  const gone = await server(SANDBOX);
  await (await gone.claim(3, {}, { holder: RUNNER_A })).park("approval");
  await gone.store.settings.put(key, { ...(await gone.store.settings.get(key)), ...RUNNER_A });
  gone.clock.now = T0 + KEEP_MS;
  assert.deepEqual(await gone.janitor({ self: RUNNER_B, runners: { live: async () => [] } }), { ended: ["c1"], failed: [] }, "runner-a gone: any runner's janitor ends it as before");
  const failing = await server(SANDBOX);
  await (await failing.claim(3, {}, { holder: RUNNER_A })).park("approval");
  await failing.store.settings.put(key, { ...(await failing.store.settings.get(key)), ...RUNNER_A });
  failing.clock.now = T0 + KEEP_MS;
  assert.deepEqual(await failing.janitor({ self: RUNNER_B, runners: { live: async () => { throw new Error("store down"); } } }), { ended: [], failed: [] }, "the runners unread: the pinned row is left for a later pass, never ended blind");
});

test("runner-b's full janitor pass, after runner-b ended runner-a's parked run, leaves runner-a's kept machine from both sweeps on a provider both runners list; once runner-a is gone or a new incarnation, the machine goes as before", async () => {
  // runner-a parked the run with its machine kept; runner-b then ended the run (a person's stop, ends-only): the run is
  // final, the row still runner-a's, inside its keep.
  const parkedThenStopped = async () => {
    const one = await server(SANDBOX);
    await (await one.claim(3, {}, { holder: RUNNER_A })).park("approval");
    one.store.runs.set("run-1", "stopped");
    one.clock.now = T0 + 60_000;
    return one;
  };
  const key = keptKeyOf("run-1");
  const one = await parkedThenStopped();
  const row = await one.store.settings.get(key);
  assert.deepEqual([row?.runner, row?.incarnation], ["runner-a", "inc-a"], "the park pinned it to runner-a");
  const logged = await one.pass({ self: RUNNER_B, runners: { live: async () => [{ ...RUNNER_A, refused: null }] } });
  // The kept pass leaves the row; the provider sweep lists the same machine, its run over, and would end it at once.
  assert.deepEqual(deletes(one.account), [], `runner-b's full janitor pass leaves runner-a's kept machine: ${JSON.stringify(logged)}`);
  assert.ok(one.account.computers.has("c1"), "still running for runner-a");
  assert.deepEqual(await one.store.settings.get(key), row, "its row as runner-a's park left it");
  // runner-a's own pass ends it: the run is over and the row is its own.
  await one.pass({ self: RUNNER_A, runners: { live: async () => [{ ...RUNNER_A, refused: null }] } });
  assert.deepEqual(deletes(one.account), ["c1"], "runner-a's own pass ends it, once");
  assert.equal(await one.store.settings.get(key), undefined, "and removes its row, the run being over");

  // runner-a gone (its word stale): runner-b's pass ends it as before, once.
  const gone = await parkedThenStopped();
  await gone.pass({ self: RUNNER_B, runners: { live: async () => [] } });
  assert.deepEqual(deletes(gone.account), ["c1"], "runner-a gone: runner-b's pass ends it");
  assert.equal(await gone.store.settings.get(key), undefined);
  // runner-a restarted under its name (a new incarnation): the machine is no live process's, and goes the same way.
  const again = await parkedThenStopped();
  await again.pass({ self: RUNNER_B, runners: { live: async () => [{ runner: "runner-a", incarnation: "inc-a2", refused: null }] } });
  assert.deepEqual(deletes(again.account), ["c1"], "runner-a's new incarnation: runner-b's pass ends it");

  // The kept rows unread: neither sweep can tell which machine is kept, so neither ends it this pass, and it is said.
  const unread = await parkedThenStopped();
  unread.store.settings.all = async () => {
    throw new Error("the store did not answer");
  };
  const said = await unread.pass({ self: RUNNER_B, runners: { live: async () => [] } });
  assert.deepEqual(deletes(unread.account), [], `the kept rows unread: nothing ended blind: ${JSON.stringify(said)}`);
  assert.ok(said.some((line) => line.startsWith("the computer janitor could not sweep docker's computers: the computers kept at a park could not be read")), JSON.stringify(said));
});

test("a Docker sandbox's park names the runner that claimed it and its incarnation; a resume by another runner that cannot reach it makes a new one, said lost with that runner and naming none", async () => {
  const one = await server(SANDBOX);
  await (await one.claim(3, {}, { holder: RUNNER_A })).park("approval");
  assert.deepEqual(await readKept(one.store.settings, "run-1"), { provider: "docker", kind: "sandbox", id: "c1", name: "c1", epoch: 3, until: T0 + KEEP_MS, folder: "bind", ...RUNNER_A }, "pinned to runner-a, this process");
  // runner-a is gone (the claim rule let runner-b have the run), and its engine with the container: runner-b's finds none.
  one.account.computers.delete("c1");
  one.clock.now = T0 + 60_000;
  const said = [];
  const resumed = await one.claim(5, { hadComputer: async () => true, onConnected: (words) => void said.push(words) }, { holder: RUNNER_B });
  assert.deepEqual(creates(one.account), ["c1", "c2"], "a new sandbox");
  assert.deepEqual(resumed.replaced, { kind: "sandbox", folderKept: false, lost: true });
  assert.equal(said.length, 1, "said once");
  assert.equal(computerReadyWords(said[0]), "The sandbox is ready: Linux (amd64), from Docker. The sandbox wasn't kept: the runner that kept it is gone. It's a new sandbox: the one before is gone, with what was on it.");
  await resumed.release();
});

test("a kept Docker sandbox its provider refuses to attach again (its proxy made before the egress bridge) is replaced: the run goes on, and its timeline says why in the provider's words", async () => {
  const one = await server(SANDBOX);
  await (await one.claim(3, {}, { holder: RUNNER_A })).park("approval");
  const words =
    "the computer c1 does not match this provider, so attach refuses it and it is left as it is: network: network allow, but its egress proxy c1-egress is on Docker's default bridge: an earlier release of this provider made it there, before the egress bridge agentrun-egress; delete the computer and create it again";
  const attach = one.account.provider.attach;
  one.account.provider.attach = async (ref, context) => {
    if (ref.id !== "c1") return attach(ref, context);
    one.account.calls.push(["attach", ref.id]);
    return { ok: false, error: { code: "refused", message: words } };
  };
  one.clock.now = T0 + 60_000;
  const said = [];
  const resumed = await one.claim(5, { hadComputer: async () => true, onConnected: (phase) => void said.push(phase) }, { holder: RUNNER_A });
  assert.ok(one.account.calls.some(([verb, id]) => verb === "attach" && id === "c1"), "the kept one was tried");
  assert.deepEqual(creates(one.account), ["c1", "c2"], "a new sandbox");
  assert.deepEqual(deletes(one.account), ["c1"], "the refused one deleted as an older claim's");
  assert.equal(resumed.computer?.kind, "sandbox", "the claim gave the run a computer, never failed");
  assert.deepEqual(resumed.replaced, { kind: "sandbox", folderKept: false, refused: words });
  assert.equal(said.length, 1, "said once");
  assert.equal(computerReadyWords(said[0]), `The sandbox is ready: Linux (amd64), from Docker. The sandbox kept before could not be taken back: ${words}. It's a new sandbox: the one before is gone, with what was on it.`);
  await resumed.release();
});

test("a phone harness kept at its park is not pinned: its row names no runner, and another runner's resume attaches the same phone", async () => {
  const one = await server({ setting: { kind: "phone", provider: "phone-harness" }, groups: PHONE_GROUPS, machine: "android", keys: { PHONE_HARNESS_API_KEY: "fake-test-key" } });
  const first = await one.claim(3, {}, { holder: RUNNER_A });
  assert.equal(await first.park(), true);
  const row = await readKept(one.store.settings, "run-1");
  assert.deepEqual([row.runner, row.incarnation], [undefined, undefined], "the vendor's phone: any runner reaches it, so nothing pins the run");
  one.clock.now = T0 + 60_000;
  const said = [];
  const resumed = await one.claim(5, { hadComputer: async () => true, onConnected: (words) => void said.push(words) }, { holder: RUNNER_B });
  assert.deepEqual(creates(one.account), ["c1"], "the same phone: no create");
  assert.equal(resumed.replaced, undefined);
  assert.equal(said[0]?.kept, true, "said to be the same one");
  await resumed.release();
  assert.deepEqual(deletes(one.account), ["c1"]);
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
  assert.equal(store.computerIntervals.rows.size, 0, "--faux's desktop is no computer of a provider's: no interval");

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
    assert.equal(pairedStore.computerIntervals.rows.size, 0, "a paired computer is no computer of the run's own: no interval");
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

// Each computer a run made, from its create to its proven delete (computer-intervals.ts): the rows the claim, its park,
// its release and the janitor write. The expected rows are worked out from the vendor's ids (c1, c2, ...) and the test's
// clock, under the setting's provider (e2b): this server's id for the provider, not the provider object's own ("fake").
const intervalsOf = (one) => one.store.computerIntervals.forRun("run-1");

test("a run's desktop has an interval: opened at its create by the provider's id, the create's asks null where it asked none; kept at the park; ended when the keep's end deletes it", async () => {
  const one = await server();
  const first = await one.claim(3);
  const opened = { runId: "run-1", provider: "e2b", providerId: "c1", kind: "desktop", gpuType: null, gpuCount: null, cpus: null, memoryMb: null, diskGb: null, startedAt: T0 };
  assert.deepEqual(await intervalsOf(one), [{ ...opened, kept: false, endedAt: null, bookedMs: 0 }]);
  one.clock.now = T0 + 30_000;
  assert.equal(await first.park(), true);
  assert.deepEqual(await intervalsOf(one), [{ ...opened, kept: true, endedAt: null, bookedMs: 0 }], "kept past its claim, not ended");
  one.clock.now = T0 + 30_000 + KEEP_MS;
  assert.deepEqual(await one.janitor(), { ended: ["c1"], failed: [] });
  assert.deepEqual(await intervalsOf(one), [{ ...opened, kept: true, endedAt: T0 + 30_000 + KEEP_MS, bookedMs: 0 }], "ended when its delete answered ok");
});

test("a run's sandbox released at its end is ended at that moment; a release whose delete fails leaves it open, never a guessed end", async () => {
  const one = await server(SANDBOX);
  const first = await one.claim(3, { spec: () => ({ ...SPEC(), cpus: 2, memoryMb: 4096 }) });
  one.clock.now = T0 + 90_000;
  await first.release();
  assert.deepEqual(await intervalsOf(one), [{ runId: "run-1", provider: "docker", providerId: "c1", kind: "sandbox", gpuType: null, gpuCount: null, cpus: 2, memoryMb: 4096, diskGb: null, startedAt: T0, kept: false, endedAt: T0 + 90_000, bookedMs: 0 }]);

  const two = await server(SANDBOX);
  const held = await two.claim(3);
  two.account.provider.release = async () => ({ ok: false, error: { code: "unavailable", message: "the vendor did not answer" } });
  await assert.rejects(held.release(), /the vendor did not answer/);
  assert.deepEqual((await intervalsOf(two)).map((row) => [row.providerId, row.endedAt]), [["c1", null]], "left open: no delete was proven");
});

test("an earlier claim's computer let go by a later claim's launch is ended; the new one is opened beside it", async () => {
  const one = await server();
  await one.claim(3);
  // The runner that held claim 3 is lost: claim 5 lets its desktop go (releaseOlderClaims) and makes a new one.
  one.clock.now = T0 + 60_000;
  const later = await one.claim(5);
  assert.deepEqual((await intervalsOf(one)).map((row) => [row.providerId, row.startedAt, row.endedAt]), [["c1", T0, T0 + 60_000], ["c2", T0 + 60_000, null]]);
  await later.release();
});

test("an earlier claim's computer deleted before another one's delete failed keeps its end, though the later claim fails (#3332 review)", async () => {
  const one = await server();
  await one.claim(3);
  // A second computer of claim 3 (a lost runner's retry), whose delete the vendor refuses.
  one.account.computers.set("x9", { id: "x9", labels: { ...one.account.computers.get("c1").labels } });
  const release = one.account.provider.release.bind(one.account.provider);
  one.account.provider.release = async (ref, how) => (ref.id === "x9" ? { ok: false, error: { code: "unavailable", message: "the vendor did not answer" } } : release(ref, how));
  one.clock.now = T0 + 60_000;
  await assert.rejects(one.claim(5), /the vendor did not answer/);
  assert.deepEqual((await intervalsOf(one)).map((row) => [row.providerId, row.endedAt]), [["c1", T0 + 60_000]], "c1's delete answered ok: its end is kept");
});

test("a resumed kept desktop is the same interval: no second row, and the run's end ends it", async () => {
  const one = await server();
  await (await one.claim(3)).park();
  one.clock.now = T0 + 60_000;
  const resumed = await one.claim(5, { hadComputer: async () => true });
  one.clock.now = T0 + 120_000;
  await resumed.release();
  assert.deepEqual((await intervalsOf(one)).map((row) => [row.providerId, row.kept, row.endedAt]), [["c1", true, T0 + 120_000]]);
});

test("an interval that can't be written never fails the claim: it is said on the log, and the computer is the run's as before", async () => {
  const one = await server();
  one.store.computerIntervals = memoryIntervals({ fail: true });
  const said = [];
  const held = await one.claim(3, { log: (line) => void said.push(line) });
  assert.equal(held.computer.kind, "desktop");
  assert.equal(await held.park(), true, "its park keeps it as before");
  assert.deepEqual(said, ["the computer interval of e2b c1 (run run-1) was not written: the store is down", "the computer interval of e2b c1 was not written: the store is down"]);
});

// A computer's time on the run's ledger (compute-cost.ts), priced by the operator's per-resource settings: its first
// stretch held before its create, each stretch booked and the next held, the rest booked when it is let go. The ledger
// here records each admit and settle; `refuse` refuses a hold (never an owed booking) in the cap's words.
function ledgerOf({ refuse = () => false } = {}) {
  const admits = [];
  const settles = [];
  const pauses = [];
  const paid = {
    async admit(request) {
      if (!request.owed && refuse(request)) throw Object.assign(new Error("spend_cap_reached: this run's cap of $0.01 has no room for the computer's next stretch"), { code: "spend_cap_reached", forGood: false });
      admits.push(request);
      return {};
    },
    async settle(id, usd, options) {
      settles.push([id, usd, options?.givenBack === true]);
      return usd;
    },
  };
  return { admits, settles, pauses, ledger: { paid, pause: async (refusal) => void pauses.push(refusal) } };
}
/** $0.00001 a vCPU-second and $0.000002 a GiB-second on e2b: 2 vCPUs and 4 GiB cost $0.000028 a second, $0.0084 a stretch. */
const PRICES = { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_E2B: "0.00001", AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_E2B: "0.000002" };
const SIZED = () => ({ ...SPEC(), cpus: 2, memoryMb: 4096 });
/** The meter's timer, run by hand: `tick()` runs each stretch's tick once and waits for it. */
function ticker() {
  const ticks = new Set();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { every: (tick) => (ticks.add(tick), () => ticks.delete(tick)), settle, tick: async () => { for (const tick of ticks) tick(); await settle(); } };
}
const bookings = (admits) => admits.filter((one) => one.owed && !one.hold).map((one) => [one.tag, Math.round(one.holdUsd * 1e9) / 1e9]);

test("a priced computer's first stretch is held before its create; a cap with no room for it makes nothing, in the cap's words", async () => {
  const one = await server();
  const { ledger, admits } = ledgerOf({ refuse: () => true });
  await assert.rejects(one.claim(3, { spec: SIZED, compute: { ledger, env: PRICES } }), /spend_cap_reached: this run's cap of \$0\.01 has no room for the computer's next stretch/);
  assert.deepEqual(creates(one.account), [], "nothing made, nothing billed");
  assert.deepEqual(admits, [], "nothing held");
});

test("a priced computer's time is booked each stretch, the next held; the rest is booked at its delete, its holds given back, and its interval says how much was booked", async () => {
  const one = await server();
  const { ledger, admits, settles } = ledgerOf();
  const clock = ticker();
  const held = await one.claim(3, { spec: SIZED, compute: { ledger, env: PRICES, every: clock.every } });
  await clock.settle();
  const holds = () => admits.filter((one) => one.hold).map((one) => [one.holdUsd, one.owed === true]);
  assert.deepEqual(holds(), [[0.0084, false], [0.0084, true]], "a stretch held before the create, then one owed for the computer made");
  one.clock.now = T0 + 300_000;
  await clock.tick();
  // 300 s of 2 vCPUs at $0.00001 is $0.006; of 4 GiB at $0.000002, $0.0024.
  assert.deepEqual(bookings(admits), [["vcpu", 0.006], ["memory", 0.0024]]);
  assert.ok(admits.filter((one) => one.owed && !one.hold).every((one) => one.tool === "compute" && one.chargedBy === "e2b"));
  one.clock.now = T0 + 345_000;
  await held.release();
  // The last 45 s at its delete: $0.0009 and $0.00036.
  assert.deepEqual(bookings(admits), [["vcpu", 0.006], ["memory", 0.0024], ["vcpu", 0.0009], ["memory", 0.00036]]);
  await clock.settle();
  const holdIds = admits.filter((one) => one.hold).map((one) => one.id);
  assert.ok(holdIds.every((id) => settles.some(([settled, usd, back]) => settled === id && usd === 0 && back)), `every hold given back: ${JSON.stringify(settles)}`);
  assert.deepEqual((await intervalsOf(one)).map((row) => [row.cpus, row.memoryMb, row.bookedMs, row.endedAt]), [[2, 4096, 345_000, T0 + 345_000]]);
});

test("a cap with no room for a computer's next stretch pauses the run once, and the time it runs on is still booked, never refused", async () => {
  const one = await server();
  let full = false;
  const { ledger, admits, pauses } = ledgerOf({ refuse: () => full });
  const clock = ticker();
  const held = await one.claim(3, { spec: SIZED, compute: { ledger, env: PRICES, every: clock.every } });
  full = true;
  one.clock.now = T0 + 300_000;
  await clock.tick();
  one.clock.now = T0 + 600_000;
  await clock.tick();
  assert.equal(pauses.length, 1, "paused once, in the cap's words");
  assert.match(pauses[0].refuse, /spend_cap_reached/);
  assert.equal(pauses[0].forGood, false, "a raise lets it go on");
  assert.deepEqual(bookings(admits), [["vcpu", 0.006], ["memory", 0.0024], ["vcpu", 0.006], ["memory", 0.0024]], "both stretches booked");
  await held.release();
});

test("a computer with no price set is never refused and never held: it runs as before, its time on the usage read alone", async () => {
  const one = await server();
  const { ledger, admits } = ledgerOf({ refuse: () => true });
  const held = await one.claim(3, { spec: SIZED, compute: { ledger, env: {} } });
  assert.deepEqual(creates(one.account), ["c1"]);
  one.clock.now = T0 + 60_000;
  await held.release();
  assert.deepEqual(admits, [], "nothing held or booked");
  assert.deepEqual((await intervalsOf(one)).map((row) => row.bookedMs), [0]);
});

test("the provider's own figures price the computer where its create said them, over what was asked", async () => {
  const one = await server();
  const create = one.account.provider.create.bind(one.account.provider);
  one.account.provider.create = async (spec) => {
    const made = await create(spec);
    return { ok: true, value: { ...made.value, resources: { cpus: 4, memoryMb: 8192, diskGb: 20 } } };
  };
  const { ledger, admits } = ledgerOf();
  const clock = ticker();
  const held = await one.claim(3, { spec: SIZED, compute: { ledger, env: PRICES, every: clock.every } });
  one.clock.now = T0 + 100_000;
  await held.release();
  // 100 s of 4 vCPUs: $0.004; of 8 GiB: $0.0016. Its disk has no price set: unpriced, never booked.
  assert.deepEqual(bookings(admits), [["vcpu", 0.004], ["memory", 0.0016]]);
  assert.deepEqual((await intervalsOf(one)).map((row) => [row.cpus, row.memoryMb, row.diskGb]), [[4, 8192, 20]]);
});

test("a computer's next stretch is asked for once the booked one's hold is given back, so a cap with room for it holds it (#3338 review)", async () => {
  // A cap of $0.02 that counts what is booked and what is still held: a stretch is $0.0084. At the first tick $0.0084 is
  // booked; with the booked stretch's hold still counted, a next $0.0084 would make $0.0252 and be refused.
  const one = await server();
  const live = new Map();
  let spent = 0;
  const admits = [];
  const pauses = [];
  const paid = {
    async admit(request) {
      const held = [...live.values()].reduce((sum, usd) => sum + usd, 0);
      if (!request.owed && spent + held + request.holdUsd > 0.02 + 1e-12) throw Object.assign(new Error("spend_cap_reached: no room"), { code: "spend_cap_reached", forGood: false });
      admits.push(request);
      if (request.hold) live.set(request.id, request.holdUsd);
      else spent += request.holdUsd;
      return {};
    },
    async settle(id, usd) {
      live.delete(id);
      return usd;
    },
  };
  const clock = ticker();
  const held = await one.claim(3, { spec: SIZED, compute: { ledger: { paid, pause: async (refusal) => void pauses.push(refusal) }, env: PRICES, every: clock.every } });
  await clock.settle();
  one.clock.now = T0 + 300_000;
  await clock.tick();
  assert.deepEqual(pauses, [], "the run is not paused: the cap has room for the next stretch");
  assert.equal(live.size, 1, "the next stretch is held");
  assert.ok(Math.abs([...live.values()][0] - 0.0084) < 1e-9);
  await held.release();
  await clock.settle();
  assert.equal(live.size, 0, "every hold given back at its delete");
});

test("a computer whose resources the operator priced at $0 is booked at $0 each stretch, never held, so its usage reads $0 and not unpriced (#3338 review)", async () => {
  const one = await server();
  const { ledger, admits } = ledgerOf({ refuse: () => true });
  const clock = ticker();
  const env = { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_E2B: "0", AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_E2B: "0" };
  const held = await one.claim(3, { spec: SIZED, compute: { ledger, env, every: clock.every } });
  assert.deepEqual(creates(one.account), ["c1"], "made, though the cap refuses every hold: nothing is held");
  one.clock.now = T0 + 300_000;
  await clock.tick();
  one.clock.now = T0 + 345_000;
  await held.release();
  assert.deepEqual(admits.filter((one) => one.hold), [], "nothing held");
  assert.deepEqual(bookings(admits), [["vcpu", 0], ["memory", 0], ["vcpu", 0], ["memory", 0]], "each stretch booked at $0");
  assert.deepEqual((await intervalsOf(one)).map((row) => row.bookedMs), [345_000], "its time is held by the claim, not unheld");
});
