// The run's computer at its claim (serve/src/workspace/computer-for-claim.ts computerForClaim), the one call the runner's
// specs make: the agent's setting resolved in the server's mode, its provider made with its sealed keys, the computer
// started under the run's labels (the run's folder mounted only where the provider mounts it), a desktop registered for
// its owner's view and take-over with the provider's stream, and released once at the run's end. Kind none is no
// computer; a provider with no key, Mode 1's non-Docker sandbox and Mode 2's Docker are refused in words with code
// computer_unavailable, before anything is made. Every provider here is a loopback fake; the kind registry is the
// agreed stand-in (workspace-kinds-fixture.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { putSealedKey } from "../dist/server-keys.js";
import { computerForClaim, localWorkspace } from "../dist/workspace/index.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-claim-computer-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}

/** The store's three parts the claim reads: no revision, sealed keys in memory, a ledger in memory. */
function memoryStore() {
  const keys = new Map();
  const ledger = new Map();
  return {
    agents: { revision: async () => undefined },
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async (name) => void keys.delete(name), all: async () => [...keys].map(([name]) => ({ name })) },
    computerLedger: { put: async (p, id, labels, detail) => void ledger.set(`${p}/${id}`, { sessionId: id, labels, detail }), get: async (p, id) => ledger.get(`${p}/${id}`), list: async () => [...ledger.values()], remove: async (p, id) => void ledger.delete(`${p}/${id}`) },
  };
}

/** A provider stand-in in the computer module's shape: create records its spec, connect answers a fake computer over the
 *  run's folder, stream gives a viewer, release records each call. */
function fakeProvider(root, record, groups, machine = "linux") {
  const computer = fakeComputer(root);
  return {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    // The run's computers it holds already: an earlier claim's, by its labels.
    async list(labels) {
      const held = (record.existing ?? []).filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: one.ref, labels: one.labels, deadline: one.deadline, state: "running", network: "none" })) };
    },
    async create(spec) {
      record.created.push(spec);
      return { ok: true, value: { id: "c1", name: "c1" } };
    },
    async connect() {
      return { ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: machine, arch: "amd64", groups }, close: async () => {} } };
    },
    async attach() {
      const read = await computer.readBack();
      return { ok: true, value: { id: "c1", name: "c1", spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    // tl-computer's watch of the screen: what feeds the run's proxied live view.
    watch(ref, { signal }) {
      record.watched = [...(record.watched ?? []), [ref.id, signal instanceof AbortSignal]];
      return { frames: [] };
    },
    async release(ref, how) {
      record.released.push([ref.id, how]);
      return { ok: true, value: undefined };
    },
  };
}

const SPEC = () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" });

/** A stand-in for tl-browser's openComputerView (computer-live.ts), in its exact type: records each open and each close,
 *  and answers `refusal` when given. Test fixture only. */
function views(refusal) {
  const opened = [];
  const closed = [];
  const open = async (args) => {
    opened.push({ kind: args.kind, input: args.input, tag: args.tag, claim: args.claim, sealKey: Buffer.isBuffer(args.sealKey), hold: typeof args.hold?.take, watched: args.watch(new AbortController().signal) !== undefined });
    if (refusal) return { ok: false, refused: refusal, message: `the store refused the viewer (${refusal})` };
    return { ok: true, view: { close: (why) => void closed.push(why) } };
  };
  return { open, opened, closed };
}

async function claim(setting, { mode = 1, keys = {}, groups = ["exec", "files", "processes"], existing, view, machine = setting.kind === "desktop" ? "desktop" : setting.kind === "phone" ? "android" : "linux" } = {}) {
  const root = scratch();
  const store = memoryStore();
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, sealKey, name, value);
  const record = { created: [], released: [], options: [], ...(existing ? { existing } : {}) };
  const providers = Object.fromEntries(["docker", "e2b", "daytona", "phone-harness"].map((id) => [id, (options, extras) => (record.options.push([id, options, typeof extras.ledger.put]), fakeProvider(root, record, groups, machine))]));
  record.revoked = 0;
  const revokeMount = async () => void (record.revoked += 1);
  const run = () => computerForClaim({ runId: "run-1", epoch: 3, computer: setting }, store, { mode, kinds: KINDS, sealKey, providers, spec: SPEC, workspace: localWorkspace(root), check: { readBackOf, epoch: 3 }, revokeMount, ...(view ? { openComputerView: view.open } : {}) });
  return { root, record, run };
}

test("kind none is no computer: nothing made, a release that does nothing", async () => {
  const { record, run } = await claim({ kind: "none" });
  const answer = await run();
  assert.equal(answer.computer, undefined);
  await answer.release();
  assert.deepEqual(record, { created: [], released: [], options: [], revoked: 0 });
});

test("a Mode 1 sandbox on Docker is made under the run's labels with the run's folder mounted, and released once", async () => {
  const { record, run } = await claim({ kind: "sandbox", provider: "docker" });
  const answer = await run();
  assert.equal(answer.computer.kind, "sandbox");
  assert.equal(record.created.length, 1);
  assert.deepEqual(record.created[0].labels, { "agentrun.run": "run-1", "agentrun.epoch": "3" });
  assert.equal(record.created[0].mount?.kind, "bind", "the run's folder, as the provider binds it");
  assert.equal(record.created[0].image, "agentrun/computer:test");
  assert.equal(record.options[0][2], "function", "the provider is handed the store's ledger");
  await answer.release();
  await answer.release();
  assert.deepEqual(record.released, [["c1", "delete"]], "released once");
  assert.equal(record.revoked, 1, "the run's mount credential is removed once, after the computer");
});

test("a desktop opens one proxied live view under the claim, is held for take-over, and on release closes the view 'released' and its hold", async () => {
  const view = views();
  const { record, run } = await claim({ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "ek-test" }, groups: ["screen", "input.pointer", "input.keys"], view });
  const answer = await run();
  assert.equal(answer.computer.kind, "desktop");
  assert.equal(record.created[0].mount, undefined, "E2B mounts nothing in Mode 1");
  assert.deepEqual(record.options[0].slice(0, 2), ["e2b", { apiKey: "ek-test" }], "made with its key, by the option it fills");
  assert.deepEqual(view.opened, [{ kind: "desktop", input: "desktop", tag: "c1", claim: { runId: "run-1", epoch: 3 }, sealKey: true, hold: "function", watched: true }], "one view, tagged with the computer's ref id, fed by the provider's watch");
  assert.equal(answer.held?.kind, "desktop", "the hold and its kind, for the spec's AdapterRunSpec.computer");
  assert.equal(typeof answer.hold, "function", "the person's hold on its ports, for runTools");
  // A take in force when the computer goes ends released, and the hold takes nothing after.
  assert.equal(answer.held.hold.take(), true);
  await answer.release();
  await answer.release("ended");
  assert.deepEqual(view.closed, ["released"], "closed once");
  assert.equal(answer.held.hold.state(), "agent", "the take ended released");
  assert.equal(answer.held.hold.take(), false, "the hold is closed");
  assert.deepEqual(record.released, [["c1", "delete"]]);
});

test("a phone's view is opened with its platform, as the phone says it: android, or ios", async () => {
  const PHONE = ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"];
  for (const machine of ["android", "ios"]) {
    const view = views();
    const { run } = await claim({ kind: "phone", provider: "phone-harness" }, { keys: { PHONE_HARNESS_API_KEY: "pk-test" }, groups: PHONE, machine, view });
    const answer = await run();
    assert.equal(answer.computer.kind, "phone");
    assert.deepEqual(view.opened.map((one) => [one.kind, one.input]), [["phone", machine]]);
    await answer.release();
  }
});

test("at the run's end the view closes 'ended'", async () => {
  const view = views();
  const { run } = await claim({ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "ek-test" }, groups: ["screen", "input.pointer", "input.keys"], view });
  const answer = await run();
  await answer.release("ended");
  assert.deepEqual(view.closed, ["ended"]);
});

test("a fenced view registration is a lost claim, in words: the desktop just made is released", async () => {
  const view = views("fenced");
  const { record, run } = await claim({ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "ek-test" }, groups: ["screen", "input.pointer", "input.keys"], view });
  const error = await run().then(() => undefined, (thrown) => thrown);
  assert.equal(error?.code, "claim_lost");
  assert.match(error.message, /run run-1's claim \(epoch 3\) is no longer this runner's/);
  assert.deepEqual(record.released, [["c1", "delete"]]);
  assert.equal(record.revoked, 1, "the mount credential goes with it");
});

test("a sandbox opens no live view", async () => {
  const view = views();
  const { run } = await claim({ kind: "sandbox", provider: "docker" }, { view });
  const answer = await run();
  assert.deepEqual(view.opened, []);
  await answer.release();
});

test("the run's computer of an earlier claim is released before this claim's is made", async () => {
  const older = { ref: { id: "old", name: "old" }, labels: { "agentrun.run": "run-1", "agentrun.epoch": "2" } };
  const { record, run } = await claim({ kind: "sandbox", provider: "docker" }, { existing: [older] });
  const answer = await run();
  assert.deepEqual(record.released, [["old", "delete"]], "epoch 2's released first");
  assert.equal(record.created.length, 1);
  await answer.release();
});

test("the runner's start sweeps each provider's computers past their deadline, once", async () => {
  const { sweepComputers } = await import("../dist/workspace/index.js");
  const record = { created: [], released: [], options: [], existing: [{ ref: { id: "late", name: "late" }, labels: { "agentrun.box": "1" }, deadline: new Date(1) }, { ref: { id: "fresh", name: "fresh" }, labels: { "agentrun.box": "1" }, deadline: new Date(Date.now() + 60_000) }] };
  const swept = await sweepComputers([fakeProvider(scratch(), record, [])], { "agentrun.box": "1" });
  assert.equal(swept.length, 1);
  assert.equal(swept[0].swept.ok, true, JSON.stringify(swept));
  assert.deepEqual(record.released, [["late", "delete"]]);
});

test("a faux desktop (--faux's launch) is the kinded RunComputer: kind desktop, the groups the computer declares", async () => {
  const { fauxComputers } = await import("../dist/faux-computers.js");
  const faux = fauxComputers({ viewerBase: "http://127.0.0.1:9" });
  const store = memoryStore();
  const root = scratch();
  const answer = await computerForClaim({ runId: "run-faux", epoch: 1, computer: { kind: "desktop", provider: "faux-desktop" } }, store, {
    mode: 1, kinds: faux.kinds, sealKey: randomBytes(32), providers: {}, spec: SPEC, keyTable: faux.keyTable, launch: faux.launch,
    workspace: localWorkspace(root), check: { readBackOf, epoch: 1 },
  });
  assert.equal(answer.computer.kind, "desktop");
  assert.deepEqual([...answer.computer.groups], ["screen", "input.pointer", "input.keys"]);
  await answer.release();
});

test("a phone is the kinded RunComputer: kind phone, the groups its hello declares", async () => {
  const PHONE = ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"];
  const { run } = await claim({ kind: "phone", provider: "phone-harness" }, { keys: { PHONE_HARNESS_API_KEY: "pk-test" }, groups: PHONE, machine: "android" });
  const answer = await run();
  assert.equal(answer.computer.kind, "phone");
  assert.deepEqual([...answer.computer.groups], PHONE);
  await answer.release();
});

test("a computer whose hello does not serve the setting's kind is refused in the registry's words and released", async () => {
  // A phone that declares no apps group.
  const phone = await claim({ kind: "phone", provider: "phone-harness" }, { keys: { PHONE_HARNESS_API_KEY: "pk-test" }, groups: ["screen", "input.touch"], machine: "android" });
  const refused = await phone.run().then(() => undefined, (error) => error);
  assert.equal(refused?.code, "computer_unavailable");
  assert.match(refused.message, /the run's computer can't serve a phone: kind phone needs groups apps/);
  assert.deepEqual(phone.record.released, [["c1", "delete"]], "released, never handed on");
  // A desktop setting whose computer says it is a linux machine.
  const desktop = await claim({ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "ek-test" }, groups: ["screen", "input.pointer", "input.keys"], machine: "linux" });
  const notDesktop = await desktop.run().then(() => undefined, (error) => error);
  assert.match(notDesktop?.message ?? "", /kind desktop is a desktop machine, not a linux one/);
  assert.deepEqual(desktop.record.released, [["c1", "delete"]]);
});

async function refusal(setting, options) {
  const { record, run } = await claim(setting, options);
  const error = await run().then(() => undefined, (thrown) => thrown);
  assert.ok(error, "refused");
  assert.equal(error.code, "computer_unavailable");
  assert.deepEqual(record.created, [], "nothing made");
  return error.message;
}

test("a provider whose key is not saved is refused in words that name the key and the setting", async () => {
  assert.match(await refusal({ kind: "desktop", provider: "e2b" }), /E2B needs its key E2B_API_KEY saved: add it in Settings → Computers/);
});

test("Mode 1 refuses a sandbox that is not Docker's; Mode 2 refuses Docker's", async () => {
  assert.match(await refusal({ kind: "sandbox", provider: "daytona" }, { keys: { DAYTONA_API_KEY: "dk" } }), /Mode 1 runs a sandbox only on Docker/);
  assert.match(await refusal({ kind: "sandbox", provider: "docker" }, { mode: 2 }), /Mode 2 keeps workspaces on Archil/);
});
