// A sandbox the claim made, lost mid-run (computer-for-claim.ts lostAware), at the claim's own seam: in Mode 2 the new
// one is made as the lost one was, under the claim's labels and its own request, with the lost one's mount credential
// removed and a new one minted for its mount, which is read back before it serves a call. Only a call inside one of the
// run's tool calls (paid-calls.ts bookedIn) starts one; past the claim's bound (`recreates`) the next loss stops the run
// through its ledger's pause, for good, in computer_unavailable's words. The provider is a loopback fake; the kind
// registry is the agreed stand-in (workspace-kinds-fixture.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { putSealedKey } from "../dist/server-keys.js";
import { computerForClaim, localWorkspace } from "../dist/workspace/index.js";
import { bookedIn } from "../dist/paid-calls.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };

/** A Mode 2 claim of a Modal sandbox whose provider deletes each computer at the call `lose` picks. */
async function claim({ recreates } = {}) {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-lost-computer-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  const keys = new Map();
  const store = {
    agents: { revision: async () => undefined },
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async () => {}, all: async () => [] },
    computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
  };
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries({ MODAL_TOKEN_ID: "mi", MODAL_TOKEN_SECRET: "ms" })) await putSealedKey(store, sealKey, name, value);
  const record = { created: [], requests: [], released: [], revoked: 0, minted: 0, notes: [], lose: () => false };
  const held = new Map();
  const provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    list: async () => ({ ok: true, value: [] }),
    async create(spec, context) {
      record.created.push(spec);
      record.requests.push(context.requestId);
      const id = `c${record.created.length}`;
      held.set(id, fakeComputer(root));
      return { ok: true, value: { id, name: id } };
    },
    async connect(ref) {
      const client = {
        async call(method, params) {
          if (!held.has(ref.id)) return { ok: false, error: { code: "gone", message: `the connection to ${ref.id} ended` } };
          if (record.lose(ref.id, method)) {
            held.delete(ref.id);
            return { ok: false, error: { code: "gone", message: `the connection to ${ref.id} ended` } };
          }
          return held.get(ref.id).client.call(method, params);
        },
        close() {},
      };
      return { ok: true, value: { client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref) {
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
  const answer = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "sandbox", provider: "modal" } }, store, {
    mode: 2,
    kinds: KINDS,
    sealKey,
    providers: { modal: () => provider },
    spec: () => ({ lifetimeMs: 60_000, network: "none" }),
    workspace,
    check: { readBackOf, epoch: 3 },
    revokeMount: async () => void (record.revoked += 1),
    onComputerNote: (words) => void record.notes.push(words),
    ...(recreates === undefined ? {} : { recreates }),
  });
  const client = answer.computer.computer.client;
  const paused = [];
  /** One call of the computer's, inside a tool call of the run's (its ledger, whose pause the run stops through). */
  const inCall = (method, params) => bookedIn({ call: "toolu_1", pause: async (refusal) => void paused.push(refusal) }, () => client.call(method, params));
  return { record, answer, client, inCall, paused };
}

const STAT = ["files.stat", { path: "/workspace" }];

test("a lost Mode 2 sandbox: the next tool call's computer call starts a new one under the claim, its mount credential minted anew and the lost one's removed, read back, then serves the call", async () => {
  const { record, answer, inCall, paused } = await claim();
  assert.equal(record.minted, 1, "the claim's first mount");
  record.lose = (id, method) => id === "c1" && method === "files.stat";
  const cut = await inCall(...STAT);
  assert.deepEqual(cut, { ok: false, error: { code: "gone", message: "the connection to c1 ended" } }, "the call the loss cut answers as it did");
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
  assert.equal(answer.computer.computer.id, "c1", "the run's handle keeps its first id; its calls go to the new one");
  await answer.release();
  assert.deepEqual(record.released, [["c1", "delete"], ["c2", "delete"]], "the run's end lets the new one go");
  assert.equal(record.revoked, 2);
});

test("a call outside the run's tool calls (the run's end, the owner's channel) gets the loss's answer and starts nothing", async () => {
  const { record, client, answer } = await claim();
  record.lose = (id) => id === "c1";
  await client.call(...STAT);
  const again = await client.call(...STAT);
  assert.deepEqual(again, { ok: false, error: { code: "gone", message: "the connection to c1 ended" } });
  assert.equal(record.created.length, 1);
  await answer.release();
});

test("past `recreates` new sandboxes, the next loss stops the run for good in computer_unavailable's words, and every later call answers them", async () => {
  const { record, inCall, paused, answer } = await claim({ recreates: 1 });
  record.lose = () => true;
  await inCall(...STAT);
  await inCall(...STAT);
  assert.equal(record.created.length, 2, "one new one, which is lost too");
  const stopped = await inCall(...STAT);
  assert.equal(record.created.length, 2, "no third");
  const words = "computer_unavailable: the run's sandbox was lost 2 times, and a run starts at most 1 new one in place of a lost one: the connection to c2 ended.";
  assert.deepEqual(stopped, { ok: false, error: { code: "not_found", message: words } });
  assert.equal(paused.length, 1);
  assert.equal(paused[0].refuse, words);
  assert.equal(paused[0].forGood, true);
  assert.deepEqual(await inCall(...STAT), stopped, "a later call answers the same, starting nothing");
  assert.equal(paused.length, 1);
  await answer.release();
});
