// A run's video of its computer's screen at its claim (serve/src/workspace/computer-for-claim.ts with computer-record.ts):
// recorded only where the agent's setting says computer.record: true, through a watch of the recorder's own (beside the
// live view's, or with no viewer at all), from the claim's attach until its release, the run's end or its park; the claim
// that resumes a parked run goes on in a new file. The recordings folder is beside the run's work/ folder, never in it.
// Every provider is a loopback fake that keeps its computers across claims, and ffmpeg is a stand-in that writes what it
// reads to its file.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { putSealedKey } from "../dist/server-keys.js";
import { computerForClaim, localWorkspace } from "../dist/workspace/index.js";
import { recordingsFolder, runFolder } from "../dist/workspace/paths.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-claim-record-")));
  dirs.push(dir);
  return dir;
}

/** The store parts the claim reads, its settings shared by every claim (one server's store). */
function memoryStore() {
  const keys = new Map();
  const rows = new Map();
  return {
    runs: { get: async (id) => ({ id, state: "parked" }), heldAt: async () => undefined, list: async () => [] },
    agents: { revision: async () => undefined },
    settings: {
      get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
      put: async (key, value) => void rows.set(key, structuredClone(value)),
      replaceIf: async (key, was, value) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) && (rows.set(key, structuredClone(value)), true),
      removeIf: async (key, was) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) && rows.delete(key),
      remove: async (key) => void rows.delete(key),
      all: async (filter) => [...rows].filter(([key]) => !filter?.prefix || key.startsWith(filter.prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
    },
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async (name) => void keys.delete(name), all: async () => [...keys].map(([name]) => ({ name })) },
    computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
  };
}

/** A vendor's account, its computers kept across claims, and each watch of their screens: its handlers, signal and close. */
function vendor(root, groups, machine) {
  const computers = new Map();
  const watches = [];
  const computer = fakeComputer(root);
  let made = 0;
  const provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    async list(labels) {
      const held = [...computers.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: { id: one.id, name: one.id }, labels: { ...one.labels }, deadline: new Date(Date.now() + 3_600_000), state: "running", network: "none" })) };
    },
    async create(spec) {
      const id = `c${++made}`;
      computers.set(id, { id, labels: { ...spec.labels } });
      return { ok: true, value: { id, name: id } };
    },
    async connect({ id }) {
      const os = machine === "android" ? { os: "android", osVersion: "15" } : { os: "linux" };
      return { ok: true, value: { client: computer.client, hello: { version: "0", ...os, kind: machine, arch: "amd64", groups }, close: async () => {} } };
    },
    async attach({ id }) {
      return computers.has(id) ? { ok: true, value: { id, name: id, spec: { image: "i", user: "1000:1000", network: "none" } } } : { ok: false, error: { code: "not_found", message: `no computer ${id}` } };
    },
    async watch(ref, handlers, options) {
      const one = { id: ref.id, handlers, signal: options.signal, closed: false };
      watches.push(one);
      return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => void (one.closed = true) } };
    },
    async release(ref, how) {
      if (how === "delete") computers.delete(ref.id);
      return { ok: true, value: undefined };
    },
  };
  return { provider, watches };
}

const DESKTOP = { kind: "desktop", provider: "e2b" };
const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];
const PHONE_GROUPS = ["screen", "input.touch", "input.keys", "apps", "ui"];

/** One server: its store, a vendor's account, the run's recordings folder and its timeline's lines, and its claims of
 *  run-1 under `setting`, each recorded through a stand-in ffmpeg. */
async function server({ setting, groups = DESKTOP_GROUPS, machine = "linux", keys = { E2B_API_KEY: "fake-test-key" } }) {
  const data = scratch();
  const root = runFolder(data, "a1", "run-1");
  mkdirSync(root, { recursive: true });
  const store = memoryStore();
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, sealKey, name, value);
  const account = vendor(root, groups, machine);
  const ffmpeg = join(data, "ffmpeg");
  writeFileSync(ffmpeg, "#!/usr/bin/env node\nprocess.stdin.pipe(require(\"node:fs\").createWriteStream(process.argv.at(-1)));\n");
  chmodSync(ffmpeg, 0o755);
  const folder = recordingsFolder(data, "a1", "run-1");
  const lines = [];
  const providers = Object.fromEntries(["e2b", "phone-harness"].map((id) => [id, () => account.provider]));
  const deps = { mode: 1, kinds: KINDS, sealKey, providers, spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }), workspace: localWorkspace(root), revokeMount: async () => {}, inheritMount: () => {}, recordings: { folder, say: (words) => void lines.push(words), ffmpeg } };
  const claim = (epoch, extra = {}) => computerForClaim({ runId: "run-1", epoch, computer: setting }, store, { ...deps, check: { readBackOf, epoch }, ...extra });
  return { data, root, folder, lines, account, claim };
}

let seq = 0;
/** A frame shown to `watch`, answering whether it was acked before the show returned. */
const show = (watch, byte, format = "jpeg") => {
  let acked = false;
  watch.handlers.frame({ seq: ++seq, format, bytes: new Uint8Array([byte, byte]), width: 1280, height: 720, frameWidth: 1280, frameHeight: 720 }, () => void (acked = true));
  return acked;
};

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

test("the recordings folder is beside the run's work/ folder, never in it", () => {
  const data = "/data";
  const work = runFolder(data, "a1", "run-1");
  const recordings = recordingsFolder(data, "a1", "run-1");
  assert.match(work, /^\/data\/disk\/agents\/a1-[0-9a-f]+\/runs\/run-1\/work$/);
  assert.equal(recordings, join(dirname(work), "recordings"), "the same run's folder holds both");
  assert.ok(relative(work, recordings).startsWith(".."), "not under work/");
});

test("off by default: a desktop or a phone whose setting says no record (or record: false) is never watched for it, and nothing is written", async () => {
  for (const [setting, extra] of [[DESKTOP, {}], [{ ...DESKTOP, record: false }, {}], [{ kind: "phone", provider: "phone-harness" }, { groups: PHONE_GROUPS, machine: "android", keys: { PHONE_HARNESS_API_KEY: "fake-test-key" } }]]) {
    const one = await server({ setting, ...extra });
    const claimed = await one.claim(3);
    assert.equal(claimed.computer.kind, setting.kind);
    await sleep(50);
    assert.deepEqual(one.account.watches, [], `${JSON.stringify(setting)}: no viewer, no recorder, no watch`);
    await claimed.release();
    assert.equal(existsSync(one.folder), false, "no recordings folder");
    assert.deepEqual(one.lines, []);
  }
});

test("on: the attached desktop is recorded through a watch of its own, with no viewer open, until its release; nothing after", async () => {
  const one = await server({ setting: { ...DESKTOP, record: true } });
  const claimed = await one.claim(3);
  await until(() => one.account.watches.length === 1, "the recorder's watch");
  const [watch] = one.account.watches;
  assert.equal(watch.id, "c1", "the claim's computer");
  assert.equal(show(watch, 1), true, "acked as it came");
  await until(() => existsSync(join(one.folder, "c1.mp4")), "the file");
  await sleep(150);
  show(watch, 2);
  await sleep(150);
  await claimed.release();
  assert.equal(watch.closed, true, "the release lets the watch go");
  assert.equal(watch.signal.aborted, true);
  const size = statSync(join(one.folder, "c1.mp4")).size;
  assert.equal(size, 6, "the two frames, and the newest once more at the stop");
  assert.equal(show(watch, 3), true, "a frame after the release is acked");
  await sleep(150);
  assert.equal(statSync(join(one.folder, "c1.mp4")).size, size, "and not written");
  assert.deepEqual(one.lines, ["Recording the desktop's screen into recordings/c1.mp4."]);
  assert.deepEqual(readdirSync(one.root), [], "nothing in the run's work/ folder");
});

test("with a viewer open the recorder has a watch of its own: the viewer's acks are the viewer's, and a viewer that never acks stops nothing", async () => {
  const one = await server({ setting: { ...DESKTOP, record: true } });
  const openComputerView = async (args) => {
    // The viewer's watch: it takes the first frame and never acks it.
    await args.watch({ frame() {}, ended() {} }, { signal: new AbortController().signal });
    return { ok: true, view: { close: () => {} } };
  };
  const claimed = await one.claim(3, { openComputerView });
  await until(() => one.account.watches.length === 2, "the viewer's watch and the recorder's");
  const [viewer, recorder] = one.account.watches;
  assert.notEqual(viewer.handlers, recorder.handlers, "two watches, each its own handlers");
  assert.equal(show(viewer, 9), false, "the viewer holds its frame unacked");
  for (let i = 1; i <= 3; i += 1) {
    assert.equal(show(recorder, i), true);
    await sleep(150);
  }
  await claimed.release();
  assert.equal(statSync(join(one.folder, "c1.mp4")).size, 8, "the recorder's three frames and the newest once more, whatever the viewer did");
});

test("a park pauses it, said on the timeline; the claim that resumes the run records the same computer into the next file; the release stops it", async () => {
  const one = await server({ setting: { kind: "phone", provider: "phone-harness", record: true }, groups: PHONE_GROUPS, machine: "android", keys: { PHONE_HARNESS_API_KEY: "fake-test-key" } });
  const first = await one.claim(3);
  await until(() => one.account.watches.length === 1, "the recorder's watch");
  show(one.account.watches[0], 1, "png");
  await until(() => existsSync(join(one.folder, "c1.mp4")), "the first file");
  assert.equal(await first.park("approval"), true, "kept");
  assert.equal(one.account.watches[0].closed, true, "the park lets the recorder's watch go");
  show(one.account.watches[0], 2, "png");
  await sleep(150);
  const parked = statSync(join(one.folder, "c1.mp4")).size;
  await first.release();

  const resumed = await one.claim(5, { hadComputer: async () => true });
  await until(() => one.account.watches.length === 2, "the resumed claim's recorder watch");
  assert.equal(one.account.watches[1].id, "c1", "the same phone");
  show(one.account.watches[1], 3, "png");
  await until(() => existsSync(join(one.folder, "c1-2.mp4")), "the next file");
  await resumed.release();
  assert.equal(one.account.watches[1].closed, true, "the release lets it go");
  assert.equal(statSync(join(one.folder, "c1.mp4")).size, parked, "nothing reached the first file after the park");
  assert.deepEqual(one.lines, [
    "Recording the phone's screen into recordings/c1.mp4.",
    "The recording of the phone pauses while the run is parked: it goes on in a new file when the run resumes.",
    "Recording the phone's screen into recordings/c1-2.mp4.",
  ]);
});
