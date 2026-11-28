// The run's computer at its claim (serve/src/workspace/computer-for-claim.ts computerForClaim), the one call the runner's
// specs make: the agent's setting resolved in the server's mode, its provider made with its sealed keys, the computer
// started under the run's labels (the run's folder mounted only where the provider mounts it), a desktop's live view
// opened with its hold, and released once at the run's end (the hold ended with it). Kind none is no
// computer; a provider with no key, Mode 1's non-Docker sandbox and Mode 2's Docker are refused in words with code
// computer_unavailable, before anything is made. Every provider here is a loopback fake; the kind registry is the
// agreed stand-in (workspace-kinds-fixture.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AttachHub, readBackOf } from "@parcha/agentrun-computer";
import { FakeUiDriver, serveUiSocket } from "@parcha/agentrun-computer/fake-ui-driver";
import { putSealedKey } from "../dist/server-keys.js";
import { computerForClaim, computerSpecOf, localWorkspace } from "../dist/workspace/index.js";
import { pairedOf, scopedPairedWords } from "../dist/workspace/attached-computers.js";
import { fauxComputers } from "../dist/faux-computers.js";
import { computerReadyWords, computerStartingWords } from "../dist/workspace/computer-deps.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { GPU_ARCHIL_KINDS, KINDS } from "./workspace-kinds-fixture.mjs";

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
    // Docker's descriptor says it prepares its image: the stand-in's is ready at once, under its own tag.
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    // The run's computers it holds already: an earlier claim's, by its labels.
    async list(labels) {
      (record.listed ??= []).push(labels);
      const held = (record.existing ?? []).filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: one.ref, labels: one.labels, deadline: one.deadline, state: "running", network: "none" })) };
    },
    async create(spec, context) {
      record.created.push(spec);
      (record.requests ??= []).push(context?.requestId);
      return { ok: true, value: { id: "c1", name: "c1" } };
    },
    async connect() {
      // A phone says its OS and the OS's release (an Android's getprop); a Linux computer names no version.
      const os = machine === "android" || machine === "ios" ? { os: machine, osVersion: machine === "android" ? "15" : "18.2" } : { os: "linux" };
      return { ok: true, value: { client: computer.client, hello: { version: "0", ...os, kind: machine, arch: "amd64", groups }, close: async () => {} } };
    },
    async attach() {
      const read = await computer.readBack();
      return { ok: true, value: { id: "c1", name: "c1", spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    // The provider's watch of the screen (provider.watch(ref, handlers, options)): what feeds the run's proxied live view.
    async watch(ref, handlers, options) {
      record.watched = [...(record.watched ?? []), [ref.id, typeof handlers.frame, options.signal instanceof AbortSignal]];
      return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => {} } };
    },
    async release(ref, how) {
      record.released.push([ref.id, how]);
      return { ok: true, value: undefined };
    },
  };
}

const SPEC = () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" });

/** A stand-in for openComputerView (computer-live.ts), in its exact type: records each open and each close,
 *  and answers `refusal` when given. Test fixture only. */
function views(refusal) {
  const opened = [];
  const closed = [];
  const holds = [];
  const gones = [];
  const open = async (args) => {
    holds.push(args.hold);
    gones.push(args.gone);
    const watched = await args.watch({ frame() {}, ended() {} }, { signal: new AbortController().signal });
    opened.push({ kind: args.kind, input: args.input, tag: args.tag, claim: args.claim, sealKey: Buffer.isBuffer(args.sealKey), hold: typeof args.hold?.take, watched: watched.ok });
    if (refusal) return { ok: false, refused: refusal, message: `the store refused the viewer (${refusal})` };
    return { ok: true, view: { close: (why) => void closed.push(why) } };
  };
  return { open, opened, closed, holds, gones };
}

async function claim(setting, { mode = 1, keys = {}, groups = ["exec", "files", "processes"], existing, view, machine, unprepared = false, kinds = KINDS, onConnected, onStarting, hostWhy, hadComputer, epoch = 3, list, spec = SPEC, workspaceExec, networks, boxAllow } = {}) {
  const root = scratch();
  const store = memoryStore();
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries(keys)) await putSealedKey(store, sealKey, name, value);
  const record = { created: [], released: [], options: [], ...(existing ? { existing } : {}) };
  const providers = Object.fromEntries(["docker", "e2b", "daytona", "modal", "agent37", "phone-harness"].map((id) => [id, (options, extras) => (record.options.push([id, options, typeof extras.ledger.put]), { ...fakeProvider(root, record, groups, machine), ...(unprepared ? { prepareImage: undefined } : {}), ...(list ? { list } : {}), ...(networks ? { capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000, network: networks }) } : {}) })]));
  record.revoked = 0;
  const revokeMount = async () => void (record.revoked += 1);
  const workspace = localWorkspace(root);
  if (workspaceExec) { const execute = workspace.exec.bind(workspace); workspace.exec = (argv, options) => workspaceExec(argv, options, execute); }
  const run = () => computerForClaim({ runId: "run-1", epoch, computer: setting, ...(boxAllow ? { boxAllow } : {}) }, store, { mode, kinds, sealKey, providers, spec, workspace, check: { readBackOf, epoch }, revokeMount, ...(view ? { openComputerView: view.open } : {}), ...(onConnected ? { onConnected } : {}), ...(onStarting ? { onStarting } : {}), ...(hostWhy ? { hostWhy } : {}), ...(hadComputer ? { hadComputer } : {}) });
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
  assert.deepEqual(record.requests, ["run-1#3"], "create's request is the claim: the run and its epoch, so a retry of the claim finds its computer");
  assert.equal(record.created[0].mount?.kind, "bind", "the run's folder, as the provider binds it");
  assert.equal(record.created[0].image, "agentrun/computer:prepared", "the tag Docker's prepareImage() answered, over the spec's");
  assert.equal(record.options[0][2], "function", "the provider is handed the store's ledger");
  await answer.release();
  await answer.release();
  assert.deepEqual(record.released, [["c1", "delete"]], "released once");
  assert.equal(record.revoked, 1, "the run's mount credential is removed once, after the computer");
});

test("a bind-mounted moved project flushes its actual host filesystem before checkpoint capture", async () => {
  const calls = [];
  const { run, record } = await claim({ kind: "sandbox", provider: "docker" }, { workspaceExec: async (argv, options, execute) => {
    calls.push({ argv, options }); return execute(argv, options);
  } });
  const answer = await run();
  try {
    await answer.syncProject(new AbortController().signal);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["/usr/bin/sync", "-f", "."]);
    assert.equal(calls[0].options.timeoutMs, 30_000);
    assert.deepEqual(record.released, [], "flush happens while the original computer remains held");
    assert.equal(record.created.length, 1, "the checkpoint does not create a replacement computer");
  } finally { await answer.release(); }
});

test("a refused or timed-out bind flush cannot report a durable project", async () => {
  for (const result of [{ code: 1 }, { code: 0, timedOut: true }, { code: 0, signal: "SIGTERM" }]) {
    const { run } = await claim({ kind: "sandbox", provider: "docker" }, { workspaceExec: async () => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), ...result }) });
    const answer = await run();
    try { await assert.rejects(answer.syncProject(new AbortController().signal), /durably synchronized/); }
    finally { await answer.release(); }
  }
});

test("aborting a bind flush waits for the dispatched filesystem operation to settle", async () => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), controller = new AbortController(); let done = false;
  const { run } = await claim({ kind: "sandbox", provider: "docker" }, { workspaceExec: async (_argv, options) => {
    entered.resolve(options.signal); await finish.promise; options.signal.throwIfAborted();
  } });
  const answer = await run();
  const pending = answer.syncProject(controller.signal).finally(() => { done = true; });
  pending.catch(() => {});
  try {
    const signal = await entered.promise;
    controller.abort(new Error("fixture stopped"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true); assert.equal(done, false);
    finish.resolve(); await assert.rejects(pending, /fixture stopped/);
  } finally { finish.resolve(); await pending.catch(() => {}); await answer.release(); }
});

test("an Agent37 desktop starts from the template its prepareImage() answers, where the spec names no image for it", async () => {
  const spec = () => ({ lifetimeMs: 60_000, network: "none" });
  const { record, run } = await claim({ kind: "desktop", provider: "agent37" }, { keys: { AGENT37_API_KEY: "fake-test-key", AGENT37_SSH_KEY: "not-a-secret" }, groups: ["screen", "input.pointer", "input.keys"], spec });
  const answer = await run();
  assert.equal(record.created[0].image, "agentrun/computer:prepared");
  await answer.release();
});

test("a Mode 2 Modal sandbox starts from the image its prepareImage() answers (the box image), with the run's folder mounted", async () => {
  const spec = () => ({ lifetimeMs: 60_000, network: "none" });
  const { record, run } = await claim({ kind: "sandbox", provider: "modal" }, { mode: 2, keys: { MODAL_TOKEN_ID: "mi", MODAL_TOKEN_SECRET: "ms" }, spec });
  const answer = await run();
  assert.equal(answer.computer.kind, "sandbox");
  assert.equal(record.created[0].image, "agentrun/computer:prepared");
  assert.notEqual(record.created[0].mount, undefined, "the run's folder mounted");
  await answer.release();
});

test("a Mode 2 E2B sandbox and desktop start from the template its prepareImage() answers (the box template), each with the run's folder mounted", async () => {
  const spec = () => ({ lifetimeMs: 60_000, network: "none" });
  for (const [kind, groups] of [["sandbox", ["exec", "files", "processes"]], ["desktop", ["exec", "files", "processes", "screen", "input.pointer", "input.keys"]]]) {
    const { record, run } = await claim({ kind, provider: "e2b" }, { mode: 2, keys: { E2B_API_KEY: "fake-test-key" }, groups, spec });
    const answer = await run();
    assert.equal(answer.computer.kind, kind);
    assert.equal(record.created[0].image, "agentrun/computer:prepared", `${kind}: the prepared template`);
    assert.notEqual(record.created[0].mount, undefined, `${kind}: the run's folder mounted`);
    await answer.release();
  }
});

test("a desktop opens one proxied live view under the claim with its hold, and on release closes the view 'released' and ends the hold", async () => {
  const view = views();
  const { record, run } = await claim({ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "ek-test" }, groups: ["screen", "input.pointer", "input.keys"], view });
  const answer = await run();
  assert.equal(answer.computer.kind, "desktop");
  assert.deepEqual(answer.computer.hello, { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["screen", "input.pointer", "input.keys"] }, "the run's computer carries the hello it was connected with, for its ports");
  assert.equal(record.created[0].mount, undefined, "E2B mounts nothing in Mode 1");
  assert.deepEqual(record.options[0].slice(0, 2), ["e2b", { apiKey: "ek-test" }], "made with its key, by the option it fills");
  assert.deepEqual(view.opened, [{ kind: "desktop", input: "desktop", tag: "c1", claim: { runId: "run-1", epoch: 3 }, sealKey: true, hold: "function", watched: true }], "one view, tagged with the computer's ref id, fed by the provider's watch");
  assert.deepEqual(record.watched, [["c1", "function", true]], "the provider's watch, on the computer's ref, with the viewer's handlers and signal");
  assert.equal(typeof answer.hold, "function", "the person's hold on its ports, for runTools");
  const [hold] = view.holds;
  assert.deepEqual(answer.held, { kind: "desktop", hold }, "the same hold, for the spec's adapter loop to journal");
  assert.equal(hold.take(), true, "a person takes the desktop");
  assert.equal(hold.state(), "person");
  // The agent's ask, open when the computer goes, is let go at once: never left to wait out its own expiry.
  const asking = hold.ask({ instruction: "Sign in.", completion_condition: "Signed in." }).then(() => "answered", (error) => error.message);
  await answer.release();
  await answer.release("ended");
  assert.deepEqual(view.closed, ["released"], "closed once");
  // A take in force when the computer goes ends released (workspace/computer-hold.ts), and the hold takes nothing after.
  assert.equal(hold.state(), "agent", "the release ends the take: nothing stays parked past the run's computer");
  assert.equal(hold.take(), false, "the hold is closed");
  assert.equal(await asking, "the run's computer was let go before the person answered");
  assert.deepEqual(record.released, [["c1", "delete"]]);
});

test("a desktop's view is told whether its computer is gone by the provider's listing under the run's labels (read-only, nothing attached or started): not listed is gone; listed, running or stopped, or a listing that failed, is not", async () => {
  // The launch's own listing (the run's older claims) answers none; then each answer is the test's, in order.
  const answers = [];
  const asked = [];
  const list = async (labels) => (answers.length ? (asked.push(labels), answers.shift()) : { ok: true, value: [] });
  const view = views();
  const { run } = await claim({ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "ek-test" }, groups: ["screen", "input.pointer", "input.keys"], view, list });
  const answer = await run();
  const [gone] = view.gones;
  assert.equal(typeof gone, "function", "the view is given the question");
  const info = (id, state) => ({ ref: { id, name: id }, labels: { "agentrun.run": "run-1", "agentrun.epoch": "3" }, deadline: undefined, state, network: "none" });
  answers.push(
    { ok: true, value: [info("c1", "running")] },
    { ok: true, value: [info("c1", "stopped")] },
    { ok: false, error: { code: "vendor", vendor: "e2b", message: "E2B answered 503" } },
    // Deleted, or going: the listing leaves out a machine on its way out.
    { ok: true, value: [] },
    { ok: true, value: [info("c2", "running")] },
  );
  assert.deepEqual([await gone(), await gone(), await gone(), await gone(), await gone()], [false, false, false, true, true]);
  assert.deepEqual(asked, Array(5).fill({ "agentrun.run": "run-1", "agentrun.epoch": "3" }), "listed under the run's own labels");
  await answer.release();
});

test("a phone ended under the run, outside its release (the service listing it closing, so stopped), is gone: a phone is never stopped and kept; listed running, or a listing that failed, is not", async () => {
  const answers = [];
  const asked = [];
  const list = async (labels) => (answers.length ? (asked.push(labels), answers.shift()) : { ok: true, value: [] });
  const view = views();
  const { run } = await claim({ kind: "phone", provider: "phone-harness" }, { keys: { PHONE_HARNESS_API_KEY: "pk-test" }, groups: ["screen", "input.touch", "input.keys", "apps", "ui"], machine: "android", view, list });
  const answer = await run();
  const [gone] = view.gones;
  assert.equal(typeof gone, "function", "the phone's view is given the question");
  const info = (id, state) => ({ ref: { id, name: id }, labels: { "agentrun.run": "run-1", "agentrun.epoch": "3" }, deadline: undefined, state, network: "open" });
  answers.push(
    { ok: true, value: [info("c1", "running")] },
    { ok: false, error: { code: "vendor", vendor: "phone-harness", message: "GET /sessions answered 503" } },
    { ok: true, value: [info("c1", "stopped")] },
    { ok: true, value: [] },
  );
  assert.deepEqual([await gone(), await gone(), await gone(), await gone()], [false, false, true, true]);
  assert.deepEqual(asked, Array(4).fill({ "agentrun.run": "run-1", "agentrun.epoch": "3" }), "listed under the run's own labels");
  await answer.release();
});

test("a phone's view is opened with its platform, as the phone says it: android, or ios", async () => {
  const PHONE = ["screen", "input.touch", "input.keys", "apps", "ui"];
  for (const machine of ["android", "ios"]) {
    const view = views();
    const { run } = await claim({ kind: "phone", provider: "phone-harness" }, { keys: { PHONE_HARNESS_API_KEY: "pk-test" }, groups: PHONE, machine, view });
    const answer = await run();
    assert.equal(answer.computer.kind, "phone");
    assert.deepEqual(view.opened.map((one) => [one.kind, one.input]), [["phone", machine]]);
    await answer.release();
  }
});

test("once its computer is connected, the claim says what it is, from its hello: the OS, the OS's version where it says one, the architecture", async () => {
  const PHONE = ["screen", "input.touch", "input.keys", "apps", "ui"];
  const said = [];
  const phone = await claim({ kind: "phone", provider: "phone-harness" }, { keys: { PHONE_HARNESS_API_KEY: "pk-test" }, groups: PHONE, machine: "android", onConnected: (one) => void said.push(one) });
  const answer = await phone.run();
  assert.deepEqual(said, [{ provider: "Phone harness", kind: "phone", hello: { os: "android", osVersion: "15", arch: "amd64" } }]);
  assert.equal(computerReadyWords(said[0]), "The phone is ready: Android 15 (amd64), from Phone harness.");
  await answer.release();
  assert.equal(said.length, 1, "said once, never at the release");

  const sandbox = await claim({ kind: "sandbox", provider: "docker" }, { onConnected: (one) => void said.push(one) });
  await (await sandbox.run()).release();
  assert.deepEqual(said[1], { provider: "Docker", kind: "sandbox", hello: { os: "linux", arch: "amd64" } }, "no version where the hello names none");
  assert.equal(computerReadyWords(said[1]), "The sandbox is ready: Linux (amd64), from Docker.");
});

test("before its computer is made the claim says it is starting one, so the run's timeline is never blank while a phone boots", async () => {
  const PHONE = ["screen", "input.touch", "input.keys", "apps", "ui"];
  const said = [];
  const phone = await claim({ kind: "phone", provider: "phone-harness" }, {
    keys: { PHONE_HARNESS_API_KEY: "pk-test" }, groups: PHONE, machine: "android",
    onStarting: (one) => void said.push(["starting", one, phone.record.created.length]),
    onConnected: () => void said.push(["ready"]),
  });
  const answer = await phone.run();
  assert.deepEqual(said, [["starting", { provider: "Phone harness", kind: "phone" }, 0], ["ready"]], "said once, before anything is made, then ready");
  assert.equal(computerStartingWords(said[0][1]), "Starting a phone from Phone harness…");
  await answer.release();
  assert.equal(said.length, 2, "never at the release");
});

test("a provider whose program this machine lacks is refused in words before anything is rented", async () => {
  const PHONE = ["screen", "input.touch", "input.keys", "apps", "ui"];
  const phone = await claim({ kind: "phone", provider: "phone-harness" }, { keys: { PHONE_HARNESS_API_KEY: "pk-test" }, groups: PHONE, machine: "android", hostWhy: (id) => (id === "phone-harness" ? "adb isn't installed on this server" : undefined) });
  await assert.rejects(phone.run(), (error) => error.code === "computer_unavailable" && /cannot run it: adb isn't installed on this server\./.test(error.message));
  assert.deepEqual(phone.record.created, [], "nothing rented");
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

// A later claim that starts a fresh computer for a run that had one under an earlier claim says so once, in the ready
// words, and answers `replaced` (what the model is told and what its acts are checked against). The key is a fact the
// claim knows for certain: it let go of an older claim's computer of the run (a lost runner, a crash), or the run's
// journal holds the record an earlier claim wrote when it got the run a computer of its own (`made`, the
// agentrun.computer.made entry; that claim deleted its computer at a server's stop, or at a park).
const NEW_WORDS = (kind) => `It's a new ${kind}: the one before is gone, with what was on it.`;
const OLDER = { ref: { id: "old", name: "old" }, labels: { "agentrun.run": "run-1", "agentrun.epoch": "2" } };
const DESKTOP = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];

test("a resumed claim on a fresh computer, its earlier claim's let go, says it's a new one once, in the ready words", async () => {
  const said = [];
  const { run } = await claim({ kind: "sandbox", provider: "docker" }, { existing: [OLDER], onConnected: (one) => void said.push(one) });
  const answer = await run();
  assert.deepEqual(answer.replaced, { kind: "sandbox", folderKept: false });
  assert.equal(said.length, 1);
  assert.equal(computerReadyWords(said[0]), `The sandbox is ready: Linux (amd64), from Docker. ${NEW_WORDS("sandbox")}`);
  await answer.release();
  assert.equal(said.length, 1, "said once, never at the release");
});

test("a later claim of every kind with no older computer left (a server's stop deleted it), whose run's journal says it had one, says it's a new one", async () => {
  const kinds = [
    [{ kind: "sandbox", provider: "docker" }, {}, "sandbox", "Linux (amd64), from Docker"],
    [{ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "fake-test-key" }, groups: DESKTOP }, "desktop", "Linux (amd64), from E2B"],
    [{ kind: "phone", provider: "phone-harness" }, { keys: { PHONE_HARNESS_API_KEY: "fake-test-key" }, groups: ["screen", "input.touch", "input.keys", "apps", "ui"], machine: "android" }, "phone", "Android 15 (amd64), from Phone harness"],
  ];
  for (const [setting, options, kind, from] of kinds) {
    for (const [had, expected] of [[true, { kind, folderKept: false }], [false, undefined]]) {
      const said = [];
      const asked = [];
      const { run } = await claim(setting, { ...options, hadComputer: async () => (asked.push(1), had), onConnected: (one) => void said.push(one) });
      const answer = await run();
      assert.equal(asked.length, 1, `${kind}: the journal asked once`);
      assert.deepEqual(answer.replaced, expected, kind);
      assert.equal(answer.made, kind, `${kind}: the run's own computer, recorded by the claim's pass`);
      assert.equal(computerReadyWords(said[0]), `The ${kind} is ready: ${from}.${had ? ` ${NEW_WORDS(kind)}` : ""}`);
      await answer.release();
    }
  }
});

test("the run's journal is read before anything is rented: a read that fails fails the claim with nothing made", async () => {
  for (const [setting, options] of [[{ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "fake-test-key" }, groups: DESKTOP }], [{ kind: "sandbox", provider: "docker" }, {}]]) {
    const { record, run } = await claim(setting, { ...options, hadComputer: async () => { throw new Error("the journal read failed"); } });
    await assert.rejects(run(), /the journal read failed/);
    assert.deepEqual(record.created, [], `${setting.kind}: nothing rented`);
  }
});

test("a first claim gets no such line and never asks the journal, nor does a later claim that let nothing go and whose run had no computer", async () => {
  const said = [];
  const asked = [];
  const first = await claim({ kind: "sandbox", provider: "docker" }, { epoch: 1, hadComputer: async () => (asked.push(1), true), onConnected: (one) => void said.push(one) });
  const made = await first.run();
  assert.equal(made.replaced, undefined);
  assert.deepEqual(asked, [], "a first claim has nothing before it to ask about");
  assert.equal(made.made, "sandbox", "its computer recorded, for a later claim");
  assert.equal(made.fresh, true, "one this claim started");
  assert.equal(computerReadyWords(said[0]), "The sandbox is ready: Linux (amd64), from Docker.");
  await made.release();
  const later = await claim({ kind: "sandbox", provider: "docker" }, { onConnected: (one) => void said.push(one) });
  const remade = await later.run();
  assert.equal(remade.replaced, undefined);
  assert.equal(computerReadyWords(said[1]), "The sandbox is ready: Linux (amd64), from Docker.");
  await remade.release();
});

/** Two ends of one socket, delivering in order (a paired computer's driver on one, the hub on the other). */
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

test("a computer that isn't the run's own is neither recorded nor called a new one, and the journal is not asked for it: kind none, --faux's desktop, a paired computer", async () => {
  const asked = [];
  const hadComputer = async () => (asked.push(1), true);
  const none = await (await claim({ kind: "none" }, { hadComputer })).run();
  assert.equal(none.made, undefined, "kind none");

  const faux = fauxComputers();
  const fauxDeps = { mode: 1, kinds: faux.kinds, keyTable: faux.keyTable, launch: faux.launch, providers: {}, spec: () => ({ image: "faux", lifetimeMs: 60_000, network: "open" }), check: { readBackOf }, workspace: localWorkspace(scratch()), hadComputer };
  const fauxDesk = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "desktop", provider: "faux-desktop" } }, memoryStore(), fauxDeps);
  assert.deepEqual([fauxDesk.made, fauxDesk.replaced], [undefined, undefined], "--faux's desktop");
  assert.equal(fauxDesk.fresh, true, "--faux's desktop is started by the claim all the same");
  await fauxDesk.release();

  const driver = new FakeUiDriver({ groups: ["screen", "input.pointer", "input.keys", "apps", "ui"] });
  const row = { id: "c-1", name: "Test Mac", hello: driver.hello(), driver: "0", labels: { owner: "test" }, pairingId: "p-1", createdAt: 0, seenAt: 0, revokedAt: null };
  const hub = new AttachHub();
  const [served, computer] = socketPair();
  serveUiSocket(driver, computer);
  assert.equal((await hub.accept(pairedOf(row), served)).ok, true);
  try {
    const said = [];
    const store = memoryStore();
    const pairedDeps = { mode: 1, kinds: KINDS, sealKey: randomBytes(32), providers: {}, spec: () => ({ image: "attached", lifetimeMs: 60_000, network: "open" }), check: { readBackOf, epoch: 3 }, workspace: localWorkspace(scratch()), attached: { rows: async () => [row], hub }, hadComputer, onConnected: (one) => void said.push(one) };
    const held = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "desktop", provider: row.id } }, store, pairedDeps);
    assert.deepEqual([held.made, held.replaced], [undefined, undefined], "a paired computer");
    assert.equal(held.fresh, undefined, "a paired computer is never one the claim started: a person's own machine");
    assert.deepEqual(said.map((one) => one.replaced), [undefined], "its ready line says no new one");
    await held.release();
  } finally {
    driver.close();
  }
  assert.deepEqual(asked, [], "the journal never asked");
});

test("a run of an agent in a workspace never takes a paired computer: its claim refuses it in words, code computer_unavailable; the same run of an agent in none takes it", async () => {
  const driver = new FakeUiDriver({ groups: ["screen", "input.pointer", "input.keys", "apps", "ui"] });
  const row = { id: "cmp-desk", name: "Test Mac", hello: driver.hello(), driver: "0", labels: {}, pairingId: "p-1", createdAt: 0, seenAt: 0, revokedAt: null };
  const hub = new AttachHub();
  const [served, computer] = socketPair();
  serveUiSocket(driver, computer);
  assert.equal((await hub.accept(pairedOf(row), served)).ok, true);
  const workspaces = { "agent-w": "org:w1", "agent-free": null };
  const store = { ...memoryStore(), agents: { revision: async () => undefined, workspace: async (id) => workspaces[id] } };
  const deps = { mode: 1, kinds: KINDS, sealKey: randomBytes(32), providers: {}, spec: () => ({ image: "attached", lifetimeMs: 60_000, network: "open" }), check: { readBackOf, epoch: 3 }, workspace: localWorkspace(scratch()), attached: { rows: async () => [row], hub } };
  const setting = { kind: "desktop", provider: row.id };
  try {
    await assert.rejects(computerForClaim({ runId: "run-w", epoch: 1, agentId: "agent-w", computer: setting }, store, deps), (error) => {
      assert.equal(error.code, "computer_unavailable");
      assert.equal(error.message, scopedPairedWords(row.id));
      return true;
    });
    const held = await computerForClaim({ runId: "run-free", epoch: 1, agentId: "agent-free", computer: setting }, store, deps);
    assert.equal(held.computer?.kind, "desktop", "an agent in no workspace takes it");
    await held.release();
  } finally {
    driver.close();
  }
});

test("a Mode 2 computer that mounts the run's folder says the run folder is kept; Mode 1 never claims it", async () => {
  const said = [];
  const spec = () => ({ lifetimeMs: 60_000, network: "none" });
  const { record, run } = await claim({ kind: "desktop", provider: "e2b" }, { mode: 2, keys: { E2B_API_KEY: "fake-test-key" }, groups: DESKTOP, spec, existing: [OLDER], onConnected: (one) => void said.push(one) });
  const answer = await run();
  assert.notEqual(record.created[0].mount, undefined, "the run's folder mounted");
  assert.deepEqual(answer.replaced, { kind: "desktop", folderKept: true });
  assert.equal(computerReadyWords(said[0]), `The desktop is ready: Linux (amd64), from E2B. ${NEW_WORDS("desktop")} The run folder is kept.`);
  await answer.release();
});

// A run's first claim is epoch 1 (a queued run is epoch 0, and every claim and release moves it up by one): no claim came
// before it, so no computer of the run can be there to release. The vendor's list, a round trip before its create on a
// desktop run, is not asked; a later claim still asks it.
test("a run's first claim (epoch 1) makes its computer without asking the provider for older ones; a later claim asks", async () => {
  const first = await claim({ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "e2b-key" }, groups: ["screen", "input.pointer"], epoch: 1 });
  const made = await first.run();
  assert.equal(first.record.listed, undefined, "no list before the first claim's create");
  assert.deepEqual(first.record.created.map((spec) => spec.labels), [{ "agentrun.run": "run-1", "agentrun.epoch": "1" }]);
  await made.release();
  const later = await claim({ kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "e2b-key" }, groups: ["screen", "input.pointer"], epoch: 2 });
  const remade = await later.run();
  assert.deepEqual(later.record.listed, [{ "agentrun.run": "run-1" }], "the run's computers listed once, by its label, before the create");
  await remade.release();
});

async function refusal(setting, options) {
  const { record, run } = await claim(setting, options);
  const error = await run().then(() => undefined, (thrown) => thrown);
  assert.ok(error, "refused");
  assert.equal(error.code, "computer_unavailable");
  assert.deepEqual(record.created, [], "nothing made");
  return error.message;
}

test("a provider whose descriptor says it prepares its image and that has no prepareImage() breaks the contract: refused in words, nothing made", async () => {
  assert.match(await refusal({ kind: "sandbox", provider: "docker" }, { unprepared: true }), /Docker's descriptor says it prepares its image, but its provider has no prepareImage\(\)/);
});

test("a provider whose key is not saved is refused in words that name the key and the setting", async () => {
  assert.match(await refusal({ kind: "desktop", provider: "e2b" }), /E2B needs its key E2B_API_KEY saved: add it in Settings → Computers/);
});

test("Mode 1 refuses a sandbox that is not Docker's; Mode 2 refuses Docker's", async () => {
  assert.match(await refusal({ kind: "sandbox", provider: "daytona" }, { keys: { DAYTONA_API_KEY: "dk" } }), /Mode 1 runs a sandbox only on Docker/);
  assert.match(await refusal({ kind: "sandbox", provider: "docker" }, { mode: 2 }), /Mode 2 keeps workspaces on Archil/);
});

test("a desktop whose setting names an image is made with that configuration's options beside its keys, and starts from that image", async () => {
  const root = scratch();
  const store = memoryStore();
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, "ACME_TOKEN", "at-test");
  // A provider no serve file names: its keys and its configurations are its descriptor's, in its registry entry.
  const acme = { id: "acme-desk", label: "Acme Desk", kinds: ["desktop"], keys: [{ name: "ACME_TOKEN", option: "token", required: true }], mounts: [], metered: true, defaultImage: { desktop: "linux" }, capabilities: [
    { kind: "desktop", groups: ["screen", "input.pointer", "input.keys"], image: "linux", options: {} },
    { kind: "desktop", groups: ["screen", "input.pointer", "input.keys"], image: "windows", options: { os: "windows" } },
  ] };
  const kinds = { ...KINDS, PROVIDERS: [...KINDS.PROVIDERS, acme] };
  const keyTable = { keys: { "acme-desk": acme.keys }, labels: { "acme-desk": "Acme Desk" }, settings: {} };
  for (const [image, options, started] of [["windows", { token: "at-test", os: "windows" }, "windows"], [undefined, { token: "at-test" }, "linux"]]) {
    const record = { created: [], released: [], options: [] };
    const specs = [];
    const providers = { "acme-desk": (given) => (record.options.push(given), fakeProvider(root, record, ["screen", "input.pointer", "input.keys"])) };
    const spec = (entry, kind, run, named) => (specs.push(named), { ...SPEC(), ...(named ? { image: named } : {}) });
    const setting = { kind: "desktop", provider: "acme-desk", ...(image ? { image } : {}) };
    const answer = await computerForClaim({ runId: "run-1", epoch: 3, computer: setting }, store, { mode: 1, kinds, keyTable, sealKey, providers, spec, workspace: localWorkspace(root), check: { readBackOf, epoch: 3 }, revokeMount: async () => {} });
    assert.equal(answer.computer.kind, "desktop", String(image));
    assert.deepEqual(record.options, [options], "the configuration's options beside the keys'");
    assert.deepEqual(specs, [started], "the spec is asked for the configuration's image");
    assert.equal(record.created[0].image, started);
    await answer.release();
  }
});

test("a sandbox's GPUs go into the spec its provider makes the computer with; GPUs its provider does not give are refused before anything is made", async () => {
  // A GPU computer that takes the Archil mount (Modal's, once its FUSE mount is proven there), in Mode 2.
  const MODAL_KEYS = { MODAL_TOKEN_ID: "mi", MODAL_TOKEN_SECRET: "ms" };
  const { record, run } = await claim({ kind: "sandbox", provider: "modal", gpu: { type: "H100", count: 1 } }, { mode: 2, keys: MODAL_KEYS, kinds: GPU_ARCHIL_KINDS });
  const answer = await run();
  assert.deepEqual(record.created[0].gpu, { type: "H100", count: 1 });
  assert.equal(record.created[0].mount?.kind !== undefined, true, "with the run's folder mounted beside them");
  await answer.release();
  // The registry's Modal GPU computer and a Daytona sandbox take no Archil mount: in Mode 2 each holds a synced folder,
  // which a runner keeping no store for it (a folder of this machine, localWorkspace) refuses before anything is made.
  assert.equal(await refusal({ kind: "sandbox", provider: "modal", gpu: { type: "H100", count: 1 } }, { mode: 2, keys: MODAL_KEYS }), "Modal could not start a sandbox computer: this run's folder can't be synced into a computer here");
  assert.equal(await refusal({ kind: "sandbox", provider: "daytona", gpu: { type: "H100", count: 1 } }, { mode: 2, keys: { DAYTONA_API_KEY: "dk" } }), "Daytona could not start a sandbox computer: this run's folder can't be synced into a computer here");
  assert.match(await refusal({ kind: "sandbox", provider: "docker", gpu: { type: "T4", count: 1 } }), /^A Docker sandbox can't have this agent's GPUs: this provider offers no GPU/);
});

// The network each computer is made with is the server's own spec builder's (computerSpecOf, under the default list),
// and where it reaches is the claim's (ClaimComputer.reach), which the run's model is told (computerReachNote): a
// desktop whose provider makes no network but none (its programs held to loopback) is made with none and reaches
// nowhere; a sandbox under an allow list reaches that list's hosts; a sandbox of a launch that names no list is made
// with none, as it always was. A desktop whose provider makes open is made open and has no reach to tell.
test("where a computer reaches: none made with none, the list made with a list, nothing to tell made open", async () => {
  const DESKTOP_GROUPS = ["screen", "input.pointer", "input.keys"];
  for (const [what, setting, options, network, reach] of [
    ["a desktop whose provider makes none alone", { kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "ek-test" }, groups: DESKTOP_GROUPS, networks: ["none"] }, "none", "none"],
    ["a desktop whose provider makes open", { kind: "desktop", provider: "e2b" }, { keys: { E2B_API_KEY: "ek-test" }, groups: DESKTOP_GROUPS, networks: ["none", "open", "allow"] }, "open", undefined],
    ["a sandbox under an allow list", { kind: "sandbox", provider: "docker" }, { networks: ["none", "allow"], boxAllow: ["pypi.org"] }, { allow: ["pypi.org"] }, { allow: ["pypi.org"] }],
    ["a sandbox of a launch that names no list", { kind: "sandbox", provider: "docker" }, { networks: ["none", "allow"] }, "none", "none"],
  ]) {
    const { record, run } = await claim(setting, { ...options, spec: computerSpecOf({}) });
    const answer = await run();
    assert.deepEqual(record.created[0].network, network, `${what}: made with it`);
    assert.deepEqual(answer.reach, reach, `${what}: reaches ${JSON.stringify(answer.reach)}`);
    await answer.release();
  }
});
