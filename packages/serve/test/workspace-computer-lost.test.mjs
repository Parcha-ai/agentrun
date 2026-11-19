// A sandbox the claim holds, lost mid-run (computer-for-claim.ts lostAware), at the claim's own seam: in Mode 2 the new
// one is made as the lost one was, under the claim's labels and its own request, with the lost one's mount credential
// removed and a new one minted for its mount, which is read back before it serves a call. Only a call inside one of the
// run's tool calls (paid-calls.ts bookedIn) starts one, one at a time; a start that fails is tried again under the same
// request and counts for nothing; a provider read that comes back after the sandbox it asked about was replaced changes
// nothing; a sandbox taken back from the run's park is started again the same way; and the loss once the claim's bound
// (`recreates`) is reached stops the run at once, through its ledger's pause, for good, in computer_unavailable's words.
// A synced folder's new sandbox is pushed the disk's folder, and the claim's sync goes on from that sandbox's listing.
// The provider is a loopback fake; the kind registry is the agreed stand-in (workspace-kinds-fixture.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { putSealedKey } from "../dist/server-keys.js";
import { archilWorkspace, computerForClaim, localWorkspace, runKey } from "../dist/workspace/index.js";
import { KEEP_MS, readKept, writeKept } from "../dist/workspace/computer-kept.js";
import { bookedIn } from "../dist/paid-calls.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
const GONE = (id) => ({ ok: false, error: { code: "gone", message: `the connection to ${id} ended` } });
/** The answer of the call a loss cut: gone, never not_found, saying it was lost and not run again, the provider's words kept. */
const LOST = (id) => ({ ok: false, error: { code: "gone", message: `the computer ${id} was lost while this call ran, and it was not run again: the connection to ${id} ended. A new computer starts at the next call.` } });

/** The server's settings in memory, as the store keeps them: a compare-and-set on the JSON text, a prefix read. */
function memorySettings() {
  const rows = new Map();
  return {
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    put: async (key, value) => void rows.set(key, structuredClone(value)),
    replaceIf: async (key, was, value) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) && (rows.set(key, structuredClone(value)), true),
    removeIf: async (key, was) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) && rows.delete(key),
    remove: async (key) => void rows.delete(key),
    all: async (filter) => [...rows].filter(([key]) => !filter?.prefix || key.startsWith(filter.prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
  };
}

/** Where a synced claim's run folder is on its fake disk. */
const SYNCED = runKey("acme", "r1");

/** How many execs the synced sandboxes ran: each writes one byte more than the last. */
let execs = 0;

/** A fake sandbox over a folder of its own, reading back a synced folder under epoch 3: a push into it is extracted for
 *  real, its mtimes fresh as computerd's extraction sets them, and its exec writes out.txt, longer each time. The same
 *  bytes written again in the millisecond of the push that brought them would keep its size and mtime, which no sync
 *  sees (sync-folder.ts's known miss), so a test of where the exec ran never depends on the clock. */
function syncedComputer() {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-lost-synced-")));
  dirs.push(root);
  const computer = fakeComputer(root, { readBack: { kind: "sync", epoch: 3 }, exec: () => (writeFileSync(join(root, "out.txt"), `made by the exec${"!".repeat((execs += 1))}\n`), undefined) });
  const tar = [];
  computer.overrides["tar.push.begin"] = () => ({ id: "push-1" });
  computer.overrides["tar.push.write"] = ({ data }) => (tar.push(Buffer.from(data, "base64")), {});
  computer.overrides["tar.push.end"] = () => {
    const extracted = spawnSync("tar", ["-x", "-m", "-C", root], { input: Buffer.concat(tar.splice(0)) });
    if (extracted.status !== 0) throw new Error(`tar: ${extracted.stderr}`);
    return { entries: readdirSync(root).length };
  };
  return computer;
}

/**
 * A Mode 2 claim (epoch 3) of a Modal sandbox. Its provider deletes a computer at the call `record.lose(id, method)`
 * picks; `record.attachOf(ref)`, when set, answers the provider's read of a machine in place of its own; `record.refuse`
 * refuses that many creates first. `kept`: the run parked at epoch 2 keeping sandbox c0, which this claim takes back.
 * `synced`: a fake disk; the sandbox is then Daytona's with no DAYTONA_ARCHIL_EGRESS, each one holding the run's folder
 * synced from that disk (syncedComputer). `archil`: a fake disk whose sync.json the Archil mount's park and release
 * record the folder's modes and links in (syncStore), the sandbox Modal's as without it.
 */
async function claim({ recreates, kept = false, synced, archil } = {}) {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-lost-computer-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  const keys = new Map();
  const store = {
    agents: { revision: async () => undefined },
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async () => {}, all: async () => [] },
    computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
    settings: memorySettings(),
  };
  const sealKey = randomBytes(32);
  const vendor = synced ? "daytona" : "modal";
  for (const [name, value] of Object.entries(synced ? { DAYTONA_API_KEY: "fake-test-key" } : { MODAL_TOKEN_ID: "mi", MODAL_TOKEN_SECRET: "ms" })) await putSealedKey(store, sealKey, name, value);
  const record = { created: [], requests: [], released: [], revoked: 0, minted: 0, inherited: 0, notes: [], lose: () => false, attachOf: undefined, refuse: 0, lostAnswer: GONE };
  const held = new Map();
  if (kept) {
    held.set("c0", fakeComputer(root));
    await writeKept(store.settings, "run-1", { provider: "modal", kind: "sandbox", id: "c0", name: "c0", epoch: 2, until: Date.now() + KEEP_MS, folder: "archil" });
  }
  const provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    list: async () => ({ ok: true, value: [] }),
    async create(spec, context) {
      record.requests.push(context.requestId);
      if (record.refuse > 0) {
        record.refuse -= 1;
        return { ok: false, error: { code: "vendor", vendor: "modal", message: "Modal answered 503" } };
      }
      record.created.push(spec);
      const id = `c${record.created.length}`;
      held.set(id, synced ? syncedComputer() : fakeComputer(root));
      return { ok: true, value: { id, name: id } };
    },
    async connect(ref) {
      const client = {
        async call(method, params) {
          if (!held.has(ref.id)) return record.lostAnswer(ref.id);
          if (record.lose(ref.id, method)) {
            held.delete(ref.id);
            return record.lostAnswer(ref.id);
          }
          return held.get(ref.id).client.call(method, params);
        },
        close() {},
      };
      return { ok: true, value: { client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref) {
      if (record.attachOf) return record.attachOf(ref);
      const one = held.get(ref.id);
      if (!one) return { ok: false, error: { code: "not_found", message: `no fake computer has the id ${ref.id}` } };
      const read = await one.readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release(ref, how) {
      record.released.push([ref.id, how]);
      held.delete(ref.id);
      return { ok: true, value: undefined };
    },
  };
  // The run's folder: a local one standing in for the Archil folder, its mount minted (counted) at each ask.
  const local = localWorkspace(root);
  const workspace = Object.assign(Object.create(Object.getPrototypeOf(local)), local);
  workspace.mountSpec = async () => {
    record.minted += 1;
    return local.mountSpec();
  };
  workspace.attach = (computer, check) => local.attach(computer, check);
  if (archil) {
    const disk = archilWorkspace(archil, SYNCED);
    workspace.syncStore = () => disk.syncStore();
  }
  /** The run's claim at `epoch`, on this store and provider: a resume is a later one. */
  const at = (epoch) => computerForClaim({ runId: "run-1", epoch, computer: { kind: "sandbox", provider: vendor } }, store, {
    mode: 2,
    kinds: KINDS,
    sealKey,
    providers: { [vendor]: () => provider },
    spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }),
    workspace: synced ? archilWorkspace(synced, SYNCED) : workspace,
    check: { readBackOf, epoch },
    revokeMount: async () => void (record.revoked += 1),
    inheritMount: () => void (record.inherited += 1),
    onComputerNote: (words) => void record.notes.push(words),
    ...(recreates === undefined ? {} : { recreates }),
  });
  const answer = await at(3);
  const client = answer.computer.computer.client;
  const paused = [];
  /** One call of the computer's, inside a tool call of the run's (its ledger, whose pause the run stops through). */
  const inCall = (method, params) => bookedIn({ call: "toolu_1", pause: async (refusal) => void paused.push(refusal) }, () => client.call(method, params));
  return { record, answer, client, inCall, paused, store, at };
}

const STAT = ["files.stat", { path: "/workspace" }];

test("a lost Mode 2 sandbox: the next tool call's computer call starts a new one under the claim, its mount credential minted anew and the lost one's removed, read back, then serves the call", async () => {
  const { record, answer, inCall, paused } = await claim();
  assert.equal(record.minted, 1, "the claim's first mount");
  record.lose = (id, method) => id === "c1" && method === "files.stat";
  const cut = await inCall(...STAT);
  assert.deepEqual(cut, LOST("c1"), "the call the loss cut fails, saying it was lost and not run again");
  assert.equal(record.created.length, 1, "nothing made on the cut call itself");
  const next = await inCall(...STAT);
  assert.equal(next.ok, true, "the next call ran on the new sandbox");
  assert.deepEqual(record.requests, ["run-1#3", "run-1#3#lost-1"], "its own request under the claim: a retry finds it, never a second");
  assert.deepEqual(record.created[1].labels, record.created[0].labels, "the claim's labels, its epoch among them");
  assert.notEqual(record.created[1].mount, undefined, "the run's folder mounted in it");
  assert.equal(record.revoked, 1, "the lost one's mount credential removed");
  assert.equal(record.minted, 2, "a new one minted for the new mount");
  assert.deepEqual(record.released, [["c1", "delete"]], "the lost one let go");
  assert.deepEqual(record.notes, ["Its computer was lost; started a new one (c2)."]);
  assert.deepEqual(paused, []);
  await answer.release();
  assert.deepEqual(record.released, [["c1", "delete"], ["c2", "delete"]], "the run's end lets the new one go");
  assert.equal(record.revoked, 2);
});

test("an Archil-mounted sandbox lost and replaced, then released: the release records the folder's modes and links through the new one, never the lost one, so it neither fails nor leaves sync.json unwritten", async () => {
  const disk = new FakeArchilDisk();
  const { record, answer, inCall } = await claim({ archil: disk });
  record.lose = (id, method) => id === "c1" && method === "files.stat";
  assert.deepEqual(await inCall(...STAT), LOST("c1"));
  assert.equal((await inCall(...STAT)).ok, true, "c2 serves the next call");
  const before = disk.calls.length;
  await answer.release();
  const meta = disk.calls.slice(before).filter((call) => call.op === "putObject" && call.key.endsWith("sync.json"));
  assert.equal(meta.length, 1, "sync.json written once at the release, read through c2");
  assert.deepEqual(record.released, [["c1", "delete"], ["c2", "delete"]], "the new one let go at the run's end");
});

test("a lost synced sandbox: the new one is pushed the disk's folder and the claim's sync goes on from its listing, so the next exec puts the one file it wrote, never the whole folder", async () => {
  const disk = new FakeArchilDisk();
  for (const name of ["a.txt", "b.txt", "c.txt"]) disk.files.set(`${SYNCED}/${name}`, Buffer.from(name));
  const { record, answer, inCall } = await claim({ synced: disk });
  record.lose = (id, method) => id === "c1" && method === "files.stat";
  assert.deepEqual(await inCall(...STAT), LOST("c1"));
  const before = disk.calls.length;
  const ran = await inCall("exec.run", { argv: ["sh", "-c", "echo made by the exec > out.txt"], cwd: "/workspace", timeoutMs: 10_000 });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(record.created.length, 2, "a new sandbox, c2, ran it");
  const puts = disk.calls.slice(before).filter((call) => call.op === "putObject" && call.key.startsWith(`${SYNCED}/`)).map((call) => call.key);
  assert.deepEqual(puts, [`${SYNCED}/out.txt`], "the one file the exec wrote: the folder pushed into c2 is not put back");
  await answer.release();
});

test("a lost synced sandbox found by an exec, which syncs after it: that sync starts no new sandbox under it, so the disk gets only the file the next exec wrote on the new one, never the whole folder", async () => {
  const disk = new FakeArchilDisk();
  for (const name of ["a.txt", "b.txt", "c.txt"]) disk.files.set(`${SYNCED}/${name}`, Buffer.from(name));
  const { record, answer, inCall } = await claim({ synced: disk });
  record.lose = (id, method) => id === "c1" && method === "exec.run";
  const before = disk.calls.length;
  const exec = ["exec.run", { argv: ["sh", "-c", "echo made by the exec > out.txt"], cwd: "/workspace", timeoutMs: 10_000 }];
  assert.deepEqual(await inCall(...exec), LOST("c1"));
  const ran = await inCall(...exec);
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(record.created.length, 2, "a new sandbox, c2, ran it");
  const puts = disk.calls.slice(before).filter((call) => call.op === "putObject" && call.key.startsWith(`${SYNCED}/`)).map((call) => call.key);
  assert.deepEqual(puts, [`${SYNCED}/out.txt`], "the one file the exec on c2 wrote: the folder pushed into c2 is not put back");
  await answer.release();
});

test("a synced sandbox lost after an exec ran on it, found by that exec's sync: the sync marks it lost and starts nothing, so the next exec runs on a new one, never on the lost one (the first sandbox and a new one alike)", async () => {
  const disk = new FakeArchilDisk();
  for (const name of ["a.txt", "b.txt", "c.txt"]) disk.files.set(`${SYNCED}/${name}`, Buffer.from(name));
  const { record, answer, inCall } = await claim({ synced: disk });
  const exec = ["exec.run", { argv: ["sh", "-c", "echo made by the exec > out.txt"], cwd: "/workspace", timeoutMs: 10_000 }];
  for (const [lostId, nextId, made] of [["c1", "c2", 2], ["c2", "c3", 3]]) {
    record.lose = (id, method) => id === lostId && method === "files.list";
    await inCall(...exec);
    assert.equal(record.created.length, made - 1, `the sync that found ${lostId} lost started nothing`);
    record.lose = () => false;
    const before = disk.calls.length;
    const ran = await inCall(...exec);
    assert.equal(ran.ok, true, `the next exec ran on ${nextId}, not on the lost ${lostId}: ${JSON.stringify(ran)}`);
    assert.equal(record.created.length, made, `${nextId} was started for it`);
    const puts = disk.calls.slice(before).filter((call) => call.op === "putObject" && call.key.startsWith(`${SYNCED}/`)).map((call) => call.key);
    assert.deepEqual(puts, [`${SYNCED}/out.txt`], `the one file the exec on ${nextId} wrote`);
  }
  await answer.release();
});

test("two calls in flight when a hosted provider's vendor deletes the sandbox (its not_found words): both fail code gone, saying it was lost and not run again, never not_found; one new sandbox serves the next call", async () => {
  const { record, inCall, answer } = await claim();
  const deleted = (id) => `the computer ${id} (${id}) was deleted: Daytona no longer has it`;
  record.lostAnswer = (id) => ({ ok: false, error: { code: "not_found", message: deleted(id) } });
  record.lose = (id) => id === "c1";
  const both = await Promise.all([inCall(...STAT), inCall(...STAT)]);
  const words = `the computer c1 was lost while this call ran, and it was not run again: ${deleted("c1")}. A new computer starts at the next call.`;
  assert.deepEqual(both, [{ ok: false, error: { code: "gone", message: words } }, { ok: false, error: { code: "gone", message: words } }], "a not_found would read as a file or program not there, and a shell's fallback would send its command again");
  assert.equal(record.created.length, 1, "nothing made while they ran");
  assert.equal((await inCall(...STAT)).ok, true, "the next call ran on the new sandbox");
  assert.equal(record.created.length, 2);
  await answer.release();
});

test("a call outside the run's tool calls (the run's end, the owner's channel) gets the loss's answer and starts nothing", async () => {
  const { record, client, answer } = await claim();
  record.lose = (id) => id === "c1";
  assert.deepEqual(await client.call(...STAT), GONE("c1"), "the call that found the loss answers in the provider's own words");
  assert.deepEqual(await client.call(...STAT), GONE("c1"), "and so does the next one");
  assert.equal(record.created.length, 1);
  await answer.release();
});

test("the loss once `recreates` new sandboxes were started stops the run at once, in the call that found it, and every later call answers the same", async () => {
  const { record, inCall, paused, answer } = await claim({ recreates: 1 });
  record.lose = () => true;
  assert.deepEqual(await inCall(...STAT), LOST("c1"), "the first loss: a new one may still be started");
  assert.deepEqual(paused, []);
  const words = "computer_unavailable: the run's sandbox was lost 2 times, and a run starts at most 1 new one in place of a lost one: the connection to c2 ended.";
  const stopped = await inCall(...STAT);
  assert.deepEqual(stopped, { ok: false, error: { code: "not_found", message: words } }, "the call that lost the one new sandbox ends the run");
  assert.equal(record.created.length, 2, "one new one, which is lost too");
  assert.deepEqual(paused.map((one) => [one.refuse, one.forGood]), [[words, true]], "stopped for good, with no later call needed");
  assert.deepEqual(await inCall(...STAT), stopped, "a later call answers the same, starting nothing");
  assert.equal(record.created.length, 2);
  assert.equal(paused.length, 1);
  await answer.release();
});

test("a start that fails answers its words and counts for nothing: the next call tries again under the same request, and the bound still allows its new ones", async () => {
  const { record, inCall, paused, answer } = await claim({ recreates: 1 });
  record.lose = (id) => id === "c1";
  await inCall(...STAT);
  record.refuse = 2;
  for (let i = 0; i < 2; i++) {
    const refused = await inCall(...STAT);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.message, "the connection to c1 ended; a new sandbox could not be started: Modal answered 503");
  }
  const next = await inCall(...STAT);
  assert.equal(next.ok, true, "the third try started one, though the bound is 1");
  assert.deepEqual(record.requests, ["run-1#3", "run-1#3#lost-1", "run-1#3#lost-1", "run-1#3#lost-1"], "each try under the same request");
  assert.deepEqual(record.released, [["c1", "delete"]], "the lost one let go once");
  assert.deepEqual(paused, []);
  await answer.release();
});

test("a provider read that comes back after the sandbox it asked about was replaced changes nothing: the new one serves on, and no allowance is spent", async () => {
  const { record, inCall, paused, answer } = await claim({ recreates: 1 });
  // c1 is deleted; every read of it answers not_found, but the first read is held until c2 is up.
  record.lose = (id) => id === "c1";
  let reads = 0;
  let letRead;
  const held = new Promise((resolve) => (letRead = resolve));
  record.attachOf = async (ref) => {
    reads += 1;
    if (reads === 1) await held;
    return { ok: false, error: { code: "not_found", message: `no fake computer has the id ${ref.id}` } };
  };
  const slow = inCall(...STAT);
  const fast = await inCall(...STAT);
  assert.deepEqual(fast, LOST("c1"), "the second call's read confirmed the loss first");
  record.attachOf = undefined;
  assert.equal((await inCall(...STAT)).ok, true, "a new one, c2, serves");
  letRead();
  assert.deepEqual(await slow, LOST("c1"), "the late read's call is cut by the same loss: it fails in the lost words, never sent to c2");
  assert.equal((await inCall(...STAT)).ok, true, "c2 still serves: the late read did not mark it lost");
  assert.equal(record.created.length, 2);
  assert.deepEqual(record.released, [["c1", "delete"]], "c2 never let go");
  assert.deepEqual(paused, [], "no allowance spent past the one new sandbox");
  await answer.release();
});

test("a sandbox taken back from the run's park and then lost is started again under this claim: its own request and labels, the inherited credential removed, a new mount minted", async () => {
  const { record, inCall, answer } = await claim({ kept: true });
  assert.equal(record.created.length, 0, "the kept c0 taken back, nothing made");
  assert.equal(record.inherited, 1);
  assert.equal(record.minted, 0, "its mount is the one it was made with");
  record.lose = (id) => id === "c0";
  assert.deepEqual(await inCall(...STAT), LOST("c0"));
  assert.equal((await inCall(...STAT)).ok, true, "the next call ran on a new one");
  assert.deepEqual(record.requests, ["run-1#3#lost-1"], "this claim's request");
  assert.deepEqual(record.created[0].labels, { "agentrun.run": "run-1", "agentrun.epoch": "3" }, "this claim's labels, not the park's");
  assert.equal(record.created[0].image, "agentrun/computer:prepared");
  assert.notEqual(record.created[0].mount, undefined, "the run's folder mounted in it");
  assert.equal(record.revoked, 1, "the inherited credential removed");
  assert.equal(record.minted, 1, "a new one minted");
  assert.deepEqual(record.released, [["c0", "delete"]]);
  assert.deepEqual(record.notes, ["Its computer was lost; started a new one (c1)."]);
  await answer.release();
});

test("a kept sandbox replaced under this claim, then parked, is kept as the new one under this claim's epoch, and the next claim takes it back with that epoch's mount check", async () => {
  const { record, inCall, answer, store, at } = await claim({ kept: true });
  record.lose = (id) => id === "c0";
  await inCall(...STAT);
  assert.equal((await inCall(...STAT)).ok, true, "c1 replaced the kept c0");
  assert.equal(await answer.park("approval"), true, "the park keeps it");
  const row = await readKept(store.settings, "run-1");
  assert.deepEqual([row.id, row.epoch], ["c1", 3], "the new one, under the epoch its labels and mount carry, not the park's 2");
  const resumed = await at(4);
  assert.equal(record.created.length, 1, "the resume made nothing");
  assert.equal(resumed.computer.computer.id, "c1", "it took back c1");
  assert.equal(resumed.computer.check.epoch, 3, "its mount read back under epoch 3");
  await resumed.release();
});
