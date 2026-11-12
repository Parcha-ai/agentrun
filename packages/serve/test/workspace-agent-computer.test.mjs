// An agent's own computer (serve/src/workspace/agent-computer.ts, and the claim's owned path in computer-for-claim.ts):
// a persistent setting makes the computer once under the agent's owner (this server's id and the agent's), detaches it at
// the run's end, attaches it again at the next run, refuses a second run while one still holds it, and makes a new one
// (said on the timeline) when the one this server kept is gone. Archiving the agent or turning persistent off deletes it;
// the janitor's ownerGone never counts another server's owner, nor an agent that still wants its computer. The setting's
// persistent is refused (422) where the provider's configuration keeps none. Every provider is a loopback fake over the
// computer package's real registry (Orgo's Linux desktop declares persistence).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ownerLabels, readBackOf } from "@parcha/agentrun-computer";
import { computerIssues } from "../dist/computer-setting.js";
import { putSealedKey } from "../dist/server-keys.js";
import { agentComputerOf, agentComputerView, computerForClaim, localWorkspace, ownerGoneOf, reconcileAgentComputer, serverIdOf, sweepServerComputers } from "../dist/workspace/index.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-agent-computer-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}

const PERSISTENT = { kind: "desktop", provider: "orgo", persistent: true };
const KEYS = { ORGO_API_KEY: "fake-test-key", ORGO_WORKSPACE_ID: "ws-fake" };
const DESKTOP_GROUPS = ["exec", "files", "processes", "screen", "input.pointer", "input.keys"];

/** The store parts the claim, the reconcile and the janitor read, in memory: one agent whose current revision has
 *  `setting`, its settings rows, the run rows by id, sealed keys and a ledger. */
function memoryStore(setting = PERSISTENT) {
  const keys = new Map();
  const rows = new Map();
  const agents = new Map([["agent-1", { id: "agent-1", archivedAt: null, currentRevision: "rev-1" }]]);
  const revisions = new Map([["rev-1", { id: "rev-1", body: { computer: setting } }]]);
  const runs = new Map();
  return {
    rows,
    runs: { get: async (id) => runs.get(id), set: (id, state) => runs.set(id, { id, state }) },
    agents: {
      get: async (id) => agents.get(id),
      revision: async (id) => revisions.get(id),
      archive: (id) => void (agents.get(id).archivedAt = 1),
      setComputer: (computer) => revisions.set("rev-1", { id: "rev-1", body: { computer } }),
    },
    settings: {
      get: async (key) => rows.get(key),
      put: async (key, value) => void rows.set(key, structuredClone(value)),
      putIfAbsent: async (key, value) => (rows.has(key) ? rows.get(key) : (rows.set(key, structuredClone(value)), value)),
      // A compare-and-set on the JSON text, as the store's: the row as read gives the same text back.
      replaceIf: async (key, was, value) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) && (rows.set(key, structuredClone(value)), true),
      removeIf: async (key, was) => rows.has(key) && JSON.stringify(rows.get(key)) === JSON.stringify(was) && rows.delete(key),
      remove: async (key) => void rows.delete(key),
    },
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async (name) => void keys.delete(name), all: async () => [...keys].map(([name]) => ({ name })) },
    computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
  };
}

/** A provider that keeps an agent's computers, as Orgo's Linux desktop does: create with an owner, list by owner labels,
 *  attach under a claim (resumes a detached one), detach (keeps it, stopped), delete. `computers` is the vendor's side. */
function keeperProvider(root, computers, calls) {
  const computer = fakeComputer(root);
  let made = 0;
  return {
    id: "orgo",
    version: "0",
    capabilities: () => ({ kind: "desktop", groups: DESKTOP_GROUPS, lifetime: "janitor", maxLifetimeMs: 86_400_000, persistence: { keepsState: true, resume: true }, release: ["delete"], network: ["none"] }),
    check: () => [],
    async list(labels = {}) {
      const held = [...computers.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: { id: one.id, name: one.name }, labels: { ...one.labels }, deadline: undefined, state: one.state, network: "none", ...(one.owned ? { owned: true } : {}), ...(one.detachedAt ? { detachedAt: one.detachedAt } : {}) })) };
    },
    async create(spec) {
      calls.push(["create", spec]);
      made += 1;
      const id = `c-${computers.size + made}`;
      computers.set(id, { id, name: `computer-${id}`, labels: { ...spec.labels, ...ownerLabels(spec.owner) }, state: "running", owned: true });
      return { ok: true, value: { id, name: `computer-${id}` } };
    },
    async attach({ id }, { claim } = {}) {
      calls.push(["attach", id, claim]);
      const one = computers.get(id);
      if (!one) return { ok: false, error: { code: "not_found", message: `no computer ${id}` } };
      one.state = "running";
      delete one.detachedAt;
      if (claim) Object.assign(one.labels, { "agentrun.run": claim.run, "agentrun.epoch": String(claim.epoch) });
      return { ok: true, value: { id, name: one.name, spec: { image: "linux", user: "2510:2510", network: "none" } } };
    },
    async connect({ id }) {
      if (computers.get(id)?.state !== "running") return { ok: false, error: { code: "refused", message: `${id} is not running` } };
      return { ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "desktop", arch: "amd64", groups: DESKTOP_GROUPS }, close: async () => {} } };
    },
    async release(ref, how, { claim } = {}) {
      calls.push(["release", ref.id, how, ...(claim ? [claim] : [])]);
      const one = computers.get(ref.id);
      // A delete under a claim, as Orgo's: only while the computer carries exactly that claim's run and epoch.
      if (how === "delete" && claim && one && (one.labels["agentrun.run"] !== claim.run || one.labels["agentrun.epoch"] !== String(claim.epoch))) {
        return { ok: false, error: { code: "refused", message: `fenced: ${one.name} carries run "${one.labels["agentrun.run"]}" at epoch ${one.labels["agentrun.epoch"]}, not this claim's` } };
      }
      if (how === "delete") {
        computers.delete(ref.id);
        return { ok: true, value: undefined };
      }
      if (!one) return { ok: false, error: { code: "not_found", message: `no computer ${ref.id}` } };
      one.state = "stopped";
      one.detachedAt = new Date();
      return { ok: true, value: undefined };
    },
  };
}

const SPEC = () => ({ image: "linux", lifetimeMs: 60_000, network: "none" });

async function setup(setting = PERSISTENT) {
  const root = scratch();
  const store = memoryStore(setting);
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries(KEYS)) await putSealedKey(store, sealKey, name, value);
  const computers = new Map();
  const calls = [];
  const notes = [];
  const provider = keeperProvider(root, computers, calls);
  const providers = { orgo: () => provider };
  const claim = (runId, epoch = 1) =>
    computerForClaim({ runId, epoch, agentId: "agent-1", computer: setting }, store, { mode: 1, kinds: KINDS, sealKey, providers, spec: SPEC, workspace: localWorkspace(root), check: { readBackOf, epoch }, onComputerNote: (words) => notes.push(words) });
  return { store, computers, calls, notes, provider, claim };
}

test("a persistent setting's first run makes the agent's computer under its owner, with no lifetime; its end detaches it, never deletes it", async () => {
  const { store, computers, calls, notes, claim } = await setup();
  const first = await claim("run-1");
  const [[verb, spec]] = calls;
  assert.equal(verb, "create");
  const server = await serverIdOf(store);
  assert.deepEqual(spec.owner, { agent: "agent-1", server });
  assert.equal(spec.lifetimeMs, undefined, "an agent's computer has no run deadline");
  assert.deepEqual(spec.labels, { "agentrun.run": "run-1", "agentrun.epoch": "1" });
  assert.match(notes[0], /^Made this agent's own computer computer-c-1/);
  assert.deepEqual(agentComputerView(await agentComputerOf(store, "agent-1")), { provider: "orgo", image: "linux", id: "c-1", name: "computer-c-1", state: "held", run_id: "run-1", since: agentComputerView(await agentComputerOf(store, "agent-1")).since });
  await first.release();
  assert.deepEqual(calls.at(-1), ["release", "c-1", "detach"]);
  assert.equal(computers.get("c-1").state, "stopped", "kept, stopped");
  assert.equal((await agentComputerOf(store, "agent-1")).state, "detached");
});

test("the agent's next run attaches the same computer under its claim, and says so on the timeline", async () => {
  const { store, calls, notes, claim } = await setup();
  await (await claim("run-1")).release();
  const second = await claim("run-2");
  assert.equal(calls.filter(([verb]) => verb === "create").length, 1, "one computer, made once");
  assert.deepEqual(calls.find(([verb]) => verb === "attach"), ["attach", "c-1", { run: "run-2", epoch: 1 }]);
  assert.equal(notes[1], "Attached this agent's computer computer-c-1, kept from its last run.");
  const record = await agentComputerOf(store, "agent-1");
  assert.deepEqual([record.id, record.state, record.run], ["c-1", "held", "run-2"]);
  await second.release();
});

test("a computer gone at the vendor is made again, and the timeline names the one that is gone", async () => {
  const { computers, calls, notes, claim } = await setup();
  await (await claim("run-1")).release();
  computers.delete("c-1");
  await claim("run-2");
  assert.equal(calls.filter(([verb]) => verb === "create").length, 2);
  assert.match(notes[1], /^This agent's computer computer-c-1 is gone \(deleted outside this server\): made a new one, computer-c-/);
});

test("a second run while the first still holds the computer is refused at its start, naming the run; one a finished run left is taken over", async () => {
  const { store, calls, claim } = await setup();
  await claim("run-1");
  store.runs.set("run-1", "running");
  await assert.rejects(claim("run-2"), (error) => error.code === "computer_unavailable" && /held by run run-1, which is still going/.test(error.message));
  assert.equal(calls.filter(([verb]) => verb === "attach" || verb === "create").length, 1, "nothing attached or made for run-2");
  store.runs.set("run-1", "failed");
  await claim("run-2");
  assert.deepEqual(calls.filter(([verb]) => verb === "attach").at(-1).slice(0, 2), ["attach", "c-1"], "taken over under run-2's claim");
});

test("two runs of one agent that claim at once: the store's hold lets one make the computer, and refuses the other naming it", async () => {
  const { store, computers, calls, claim } = await setup();
  store.runs.set("run-1", "running");
  store.runs.set("run-2", "running");
  const [one, two] = await Promise.allSettled([claim("run-1"), claim("run-2")]);
  const won = one.status === "fulfilled" ? "run-1" : "run-2";
  const lost = one.status === "fulfilled" ? two : one;
  assert.equal([one, two].filter(({ status }) => status === "fulfilled").length, 1, "one run has the computer");
  assert.equal(lost.reason.code, "computer_unavailable");
  assert.match(lost.reason.message, new RegExp(`held by run ${won}, which is still going`));
  assert.equal(calls.filter(([verb]) => verb === "create").length, 1, "one computer made, never two");
  assert.equal(computers.size, 1);
  await (one.status === "fulfilled" ? one.value : two.value).release();
  assert.equal(store.rows.has("agent_computer_hold:agent-1"), false, "the hold goes at the run's end");
  await (await claim("run-3")).release();
  assert.equal(calls.filter(([verb]) => verb === "create").length, 1, "the next run attaches the one computer");
});

test("two runs that find the same ended holder at once: one takes it over and attaches, the other is refused naming it", async () => {
  const { store, calls, claim } = await setup();
  await claim("run-0");
  store.runs.set("run-0", "failed");
  store.runs.set("run-1", "running");
  store.runs.set("run-2", "running");
  const [one, two] = await Promise.allSettled([claim("run-1"), claim("run-2")]);
  assert.equal([one, two].filter(({ status }) => status === "fulfilled").length, 1);
  const won = one.status === "fulfilled" ? "run-1" : "run-2";
  assert.match((one.status === "rejected" ? one : two).reason.message, new RegExp(`held by run ${won}, which is still going`));
  assert.deepEqual(calls.filter(([verb]) => verb === "attach").map(([, id, claimed]) => [id, claimed.run]), [["c-1", won]]);
  assert.equal(calls.filter(([verb]) => verb === "create").length, 1);
  assert.equal(store.rows.get("agent_computer_hold:agent-1").run, won);
});

test("a launch that fails lets go of the hold, so the agent's next run is not refused", async () => {
  const { store, provider, claim } = await setup();
  const create = provider.create;
  provider.create = async () => ({ ok: false, error: { code: "vendor", message: "Orgo answered 402" } });
  await assert.rejects(claim("run-1"), /Orgo answered 402/);
  assert.equal(store.rows.has("agent_computer_hold:agent-1"), false);
  provider.create = create;
  store.runs.set("run-1", "running");
  await (await claim("run-2")).release();
});

test("a contender that read an ended holder never replaces the hold a later run took since: it reads again and is refused naming that run", async () => {
  const { store, calls, claim } = await setup();
  await claim("run-0");
  store.runs.set("run-0", "failed");
  store.runs.set("run-2", "running");
  store.runs.set("run-3", "running");
  // run-2 reads run-0's ended hold; before it replaces it, run-0 lets go and run-3 takes the hold.
  const putIfAbsent = store.settings.putIfAbsent;
  let stale = true;
  store.settings.putIfAbsent = async (key, value) => {
    const read = await putIfAbsent(key, value);
    if (stale && key === "agent_computer_hold:agent-1") {
      stale = false;
      store.rows.set(key, { v: 1, run: "run-3", at: new Date().toISOString() });
    }
    return read;
  };
  await assert.rejects(claim("run-2"), (error) => error.code === "computer_unavailable" && /held by run run-3, which is still going/.test(error.message));
  assert.equal(store.rows.get("agent_computer_hold:agent-1").run, "run-3", "run-3's hold stands");
  assert.equal(calls.filter(([verb]) => verb === "attach").length, 0, "run-2 attached nothing");
});

test("an ended run whose end comes after another run took its hold over leaves the computer to that run: it detaches nothing", async () => {
  const { store, computers, calls, claim } = await setup();
  const first = await claim("run-1");
  store.runs.set("run-1", "failed");
  store.runs.set("run-2", "running");
  const second = await claim("run-2");
  await first.release();
  assert.equal(calls.filter(([verb, , how]) => verb === "release" && how === "detach").length, 0, "run-1's end detaches nothing");
  assert.equal(computers.get("c-1").state, "running");
  assert.equal(store.rows.get("agent_computer_hold:agent-1").run, "run-2");
  const record = await agentComputerOf(store, "agent-1");
  assert.deepEqual([record.state, record.run], ["held", "run-2"]);
  await second.release();
  assert.equal(computers.get("c-1").state, "stopped", "run-2's end detaches it");
});

test("while an ended run detaches the computer, a new run is refused in words; once it lets go, the new run attaches it", async () => {
  const { store, calls, provider, claim } = await setup();
  const first = await claim("run-1");
  store.runs.set("run-1", "failed");
  store.runs.set("run-2", "running");
  const release = provider.release;
  let detached;
  const detaching = new Promise((resolve) => (detached = resolve));
  let started;
  const inDetach = new Promise((resolve) => (started = resolve));
  provider.release = async (ref, how) => {
    if (how === "detach") {
      started();
      await detaching;
    }
    return release(ref, how);
  };
  const ending = first.release();
  await inDetach;
  await assert.rejects(claim("run-2"), (error) => error.code === "computer_unavailable" && /being detached by run run-1: start this run again in a moment/.test(error.message));
  detached();
  await ending;
  await (await claim("run-2")).release();
  assert.deepEqual(calls.filter(([verb]) => verb === "attach").map(([, id, claimed]) => [id, claimed.run]), [["c-1", "run-2"]]);
});

test("a resume (the run's claim at a higher epoch) that lands between a claim's hold and its cleanup takes the hold over: the older claim's end detaches nothing and leaves the newer's hold; a lower epoch is fenced", async () => {
  const { store, computers, calls, claim } = await setup();
  const detaches = () => calls.filter(([verb, , how]) => verb === "release" && how === "detach").length;
  const older = await claim("run-1", 1);
  const resumed = await claim("run-1", 2);
  const before = detaches();
  await older.release();
  assert.equal(detaches(), before, "the epoch-1 claim's end detaches nothing");
  assert.equal(computers.get("c-1").state, "running", "the resumed claim's computer runs on");
  assert.deepEqual([store.rows.get("agent_computer_hold:agent-1").run, store.rows.get("agent_computer_hold:agent-1").epoch], ["run-1", 2], "the epoch-2 hold stands");
  const record = await agentComputerOf(store, "agent-1");
  assert.deepEqual([record.state, record.run], ["held", "run-1"]);
  await assert.rejects(claim("run-1", 1), (error) => error.code === "computer_unavailable" && /fenced: .* epoch 2, above this claim's 1/.test(error.message));
  assert.equal(store.rows.get("agent_computer_hold:agent-1").epoch, 2, "the fenced claim changed nothing");
  await resumed.release();
  assert.equal(computers.get("c-1").state, "stopped", "the epoch-2 claim's end detaches it");
  assert.equal(store.rows.has("agent_computer_hold:agent-1"), false);
});

test("a resume that lands while an older claim attaches fences that claim before it records the computer; one that lands while it detaches waits until it lets go", async () => {
  const { store, computers, calls, provider, claim } = await setup();
  await (await claim("run-0")).release();
  // The epoch-2 claim takes the hold over while the epoch-1 claim's attach is under way.
  const attach = provider.attach;
  let resumed;
  provider.attach = async (ref, context) => {
    const attached = await attach(ref, context);
    if (context?.claim?.epoch === 1 && resumed === undefined) resumed = await claim("run-1", 2);
    return attached;
  };
  await assert.rejects(claim("run-1", 1), (error) => /fenced: .* taken over by a later claim while run run-1's claim at epoch 1 attached it/.test(error.message));
  provider.attach = attach;
  assert.equal(store.rows.get("agent_computer_hold:agent-1").epoch, 2, "the epoch-1 claim's failure let go of nothing");
  assert.equal(computers.get("c-1").state, "running");
  // While the epoch-2 claim detaches at its end, an epoch-3 resume is refused in words; once it lets go, it attaches.
  const release = provider.release;
  let detached;
  const detaching = new Promise((resolve) => (detached = resolve));
  let started;
  const inDetach = new Promise((resolve) => (started = resolve));
  provider.release = async (ref, how) => {
    if (how === "detach") {
      started();
      await detaching;
    }
    return release(ref, how);
  };
  const ending = resumed.release();
  await inDetach;
  await assert.rejects(claim("run-1", 3), (error) => error.code === "computer_unavailable" && /being detached by run run-1/.test(error.message));
  detached();
  await ending;
  provider.release = release;
  await (await claim("run-1", 3)).release();
  assert.deepEqual(calls.filter(([verb]) => verb === "attach").map(([, , claimed]) => claimed.epoch), [1, 2, 3]);
});

test("a claim that loses its hold to a resume while it makes the computer deletes the one it made, under its claim; one the resume found and took is left to the resume", async () => {
  // The resume lands while the epoch-1 claim's create is under way: it finds no computer and makes its own; the epoch-1
  // claim's, made after, is a second desktop, deleted.
  {
    const { store, computers, calls, provider, claim } = await setup();
    const create = provider.create;
    let resumed;
    provider.create = async (spec) => {
      if (spec.labels["agentrun.epoch"] === "1" && resumed === undefined) resumed = await claim("run-1", 2);
      return create(spec);
    };
    await assert.rejects(claim("run-1", 1), (error) => /fenced: .* taken over by a later claim while run run-1's claim at epoch 1 made it; .*computer-c-3, which this claim made, was deleted/.test(error.message));
    assert.deepEqual(calls.filter(([verb, , how]) => verb === "release" && how === "delete").map(([, id, , claimed]) => [id, claimed]), [["c-3", { run: "run-1", epoch: 1 }]], "exactly the desktop it made, under its claim");
    assert.deepEqual([...computers.keys()], ["c-1"], "the resume's desktop alone is left");
    assert.equal(computers.get("c-1").state, "running");
    const record = await agentComputerOf(store, "agent-1");
    assert.deepEqual([record.id, record.state], ["c-1", "held"], "the resume's record stands");
    assert.equal(store.rows.get("agent_computer_hold:agent-1").epoch, 2);
    await resumed.release();
  }
  // The resume lands once the epoch-1 claim's create is done: its owner's listing finds that desktop and takes it under
  // epoch 2, so the epoch-1 claim's delete is fenced and the desktop runs on, the resume's.
  {
    const { store, computers, provider, claim } = await setup();
    const create = provider.create;
    let resumed;
    provider.create = async (spec) => {
      const made = await create(spec);
      if (spec.labels["agentrun.epoch"] === "1" && resumed === undefined) resumed = await claim("run-1", 2);
      return made;
    };
    await assert.rejects(claim("run-1", 1), (error) => /computer-c-1, which this claim made, was not deleted \(fenced: /.test(error.message));
    assert.deepEqual([[...computers.keys()], computers.get("c-1").state, computers.get("c-1").labels["agentrun.epoch"]], [["c-1"], "running", "2"]);
    assert.deepEqual([(await agentComputerOf(store, "agent-1")).id, (await agentComputerOf(store, "agent-1")).state], ["c-1", "held"]);
    await resumed.release();
    assert.equal(computers.get("c-1").state, "stopped");
  }
});

test("a launch whose record cannot be saved lets go of exactly what it acquired: a desktop it made is deleted, one it attached is detached; the hold goes", async () => {
  const { store, computers, calls, claim } = await setup();
  const put = store.settings.put;
  let fails = 1;
  store.settings.put = async (key, value) => {
    if (key === "agent_computer:agent-1" && value.state === "held" && fails-- > 0) throw new Error("the store is down");
    return put(key, value);
  };
  await assert.rejects(claim("run-1"), (error) => /the store is down; computer-c-1, which this claim made, was deleted/.test(error.message));
  assert.deepEqual(calls.filter(([verb]) => verb === "release").map(([, id, how, claimed]) => [id, how, claimed]), [["c-1", "delete", { run: "run-1", epoch: 1 }]]);
  assert.equal(computers.size, 0, "no desktop left running");
  assert.equal(await agentComputerOf(store, "agent-1"), undefined);
  assert.equal(store.rows.has("agent_computer_hold:agent-1"), false, "the hold goes");
  // The next run makes one and keeps it; the one after attaches it, and its save fails: the desktop is detached again.
  await (await claim("run-2")).release();
  fails = 1;
  await assert.rejects(claim("run-3"), /the store is down/);
  const [kept] = [...computers.values()];
  assert.equal(kept.state, "stopped", "detached, not left running");
  assert.equal((await agentComputerOf(store, "agent-1")).state, "detached");
  assert.equal(store.rows.has("agent_computer_hold:agent-1"), false);
});

test("an archive or an edit while a run holds the computer deletes nothing then, nor does the janitor; the run's end detaches it, then deletes it", async () => {
  const { store, computers, calls, provider, claim } = await setup();
  const run = await claim("run-1");
  store.runs.set("run-1", "running");
  store.agents.archive("agent-1");
  assert.equal(await reconcileAgentComputer(store, "agent-1", async () => provider), undefined, "a run still going holds it");
  assert.equal(computers.get("c-1").state, "running");
  assert.equal(calls.some(([verb, , how]) => verb === "release" && how === "delete"), false);
  const server = await serverIdOf(store);
  assert.equal(await ownerGoneOf(store, server, "orgo")({ agent: "agent-1", server }), false, "the janitor leaves it to the run too");
  await run.release();
  assert.deepEqual(calls.slice(-2), [["release", "c-1", "detach"], ["release", "c-1", "delete"]]);
  assert.equal(await agentComputerOf(store, "agent-1"), undefined);
  assert.equal(store.rows.has("agent_computer_hold:agent-1"), false);
});

test("a record written while a delete was under way (a replacement) is never erased or overwritten by that delete", async () => {
  for (const outcome of ["deleted", "failed"]) {
    const { store, claim } = await setup();
    await (await claim("run-1")).release();
    store.agents.archive("agent-1");
    const replacement = { v: 1, provider: "orgo", image: "linux", id: "c-9", name: "computer-c-9", state: "detached", at: new Date().toISOString() };
    const slow = {
      release: async () => {
        store.rows.set("agent_computer:agent-1", replacement);
        return outcome === "deleted" ? { ok: true, value: undefined } : { ok: false, error: { code: "vendor", message: "Orgo answered 503" } };
      },
    };
    const done = await reconcileAgentComputer(store, "agent-1", async () => slow);
    assert.deepEqual(done, outcome === "deleted" ? { deleted: "computer-c-1" } : { failed: "Orgo answered 503" }, outcome);
    assert.deepEqual(store.rows.get("agent_computer:agent-1"), replacement, outcome);
  }
});

test("a persistent run needs its agent: without one it is refused in words, with nothing made", async () => {
  const { store, calls } = await setup();
  const root = scratch();
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries(KEYS)) await putSealedKey(store, sealKey, name, value);
  await assert.rejects(
    computerForClaim({ runId: "run-1", epoch: 1, computer: PERSISTENT }, store, { mode: 1, kinds: KINDS, sealKey, providers: { orgo: () => keeperProvider(root, new Map(), calls) }, spec: SPEC, workspace: localWorkspace(root), check: { readBackOf, epoch: 1 } }),
    (error) => error.code === "computer_unavailable" && /persistent off/.test(error.message),
  );
  assert.deepEqual(calls, []);
});

test("archiving the agent, or turning persistent off, deletes its computer and forgets it; one it still wants is kept", async () => {
  for (const change of ["archive", "off", "other image"]) {
    const { store, computers, calls, provider, claim } = await setup();
    await (await claim("run-1")).release();
    assert.equal(await reconcileAgentComputer(store, "agent-1", async () => provider), undefined, "still wanted: nothing done");
    if (change === "archive") store.agents.archive("agent-1");
    else if (change === "off") store.agents.setComputer({ ...PERSISTENT, persistent: false });
    else store.agents.setComputer({ ...PERSISTENT, image: "windows" });
    assert.deepEqual(await reconcileAgentComputer(store, "agent-1", async () => provider), { deleted: "computer-c-1" }, change);
    assert.deepEqual(calls.at(-1), ["release", "c-1", "delete"], change);
    assert.equal(computers.size, 0, change);
    assert.equal(await agentComputerOf(store, "agent-1"), undefined, change);
  }
});

test("a delete that fails keeps the record as deleting, with the provider's words", async () => {
  const { store, provider, claim } = await setup();
  await (await claim("run-1")).release();
  store.agents.archive("agent-1");
  const refusing = { release: async () => ({ ok: false, error: { code: "vendor", message: "Orgo answered 503" } }) };
  assert.deepEqual(await reconcileAgentComputer(store, "agent-1", async () => refusing), { failed: "Orgo answered 503" });
  const record = await agentComputerOf(store, "agent-1");
  assert.deepEqual([record.state, record.why], ["deleting", "Orgo answered 503"]);
  assert.deepEqual(await reconcileAgentComputer(store, "agent-1", async () => provider), { deleted: "computer-c-1" }, "the next reconcile deletes it");
});

test("a run that ends after its agent was archived detaches, then deletes the computer it no longer has a use for", async () => {
  const { store, computers, calls, claim } = await setup();
  const run = await claim("run-1");
  store.agents.archive("agent-1");
  await run.release();
  assert.deepEqual(calls.slice(-2), [["release", "c-1", "detach"], ["release", "c-1", "delete"]]);
  assert.equal(computers.size, 0);
  assert.equal(await agentComputerOf(store, "agent-1"), undefined);
});

test("the janitor's ownerGone: another server's owner is never gone here; this server's is gone once its agent has no use for a computer of this provider", async () => {
  const store = memoryStore();
  const server = await serverIdOf(store);
  const gone = ownerGoneOf(store, server, "orgo");
  assert.equal(await gone({ agent: "agent-1", server: "aaaaaaaaaaaa" }), false, "another server's");
  assert.equal(await gone({ agent: "agent-1" }), false, "no server named: no agent of this server's");
  assert.equal(await gone({ agent: "agent-1", server }), false, "wanted");
  assert.equal(await ownerGoneOf(store, server, "docker")({ agent: "agent-1", server }), true, "wanted on another provider");
  assert.equal(await gone({ agent: "agent-9", server }), true, "no such agent");
  store.agents.archive("agent-1");
  assert.equal(await gone({ agent: "agent-1", server }), true, "archived");
});

test("the server's janitor sweeps an agent's own computer by its owner: kept while its agent wants it, whatever the time; deleted once archived; another server's never touched", async () => {
  const { store, computers, provider, claim } = await setup();
  await (await claim("run-1")).release();
  // Another server's agent of the same id, on the same vendor account: listed too, never this server's.
  computers.set("c-other", { id: "c-other", name: "computer-c-other", labels: { "agentrun.owner": "agent:agent-1", "agentrun.owner-server": "ffffffffffff" }, state: "stopped", owned: true });
  const janitor = (now) =>
    sweepServerComputers({ store: { ...store, runs: { ...store.runs, list: async () => [], heldAt: async () => undefined }, computerLedger: store.computerLedger }, computers: { kinds: KINDS, providers: { orgo: () => provider }, keyOf: async (name) => KEYS[name] }, now: () => now });
  assert.deepEqual((await janitor(Date.now() + 1e10)).find((one) => one.provider === "orgo").swept, { ok: true, value: { deleted: [], kept: 1 } });
  assert.equal(computers.size, 2);
  store.agents.archive("agent-1");
  assert.deepEqual((await janitor(Date.now())).find((one) => one.provider === "orgo").swept, { ok: true, value: { deleted: ["computer-c-1"], kept: 0 } });
  assert.deepEqual([...computers.keys()], ["c-other"], "another server's agent's computer is left");
});

test("an agent that wants its computer back after the janitor judged its owner gone keeps it: the janitor asks again under the hold, and deletes nothing", async () => {
  const { store, computers, provider, claim } = await setup();
  await (await claim("run-1")).release();
  store.agents.archive("agent-1");
  // The agent is unarchived just as the janitor takes its delete hold: after ownerGone said gone, before the delete.
  const putIfAbsent = store.settings.putIfAbsent;
  store.settings.putIfAbsent = async (key, value) => {
    if (key === "agent_computer_hold:agent-1" && value.run.startsWith("delete:")) (await store.agents.get("agent-1")).archivedAt = null;
    return putIfAbsent(key, value);
  };
  const swept = await sweepServerComputers({ store: { ...store, runs: { ...store.runs, list: async () => [], heldAt: async () => undefined }, computerLedger: store.computerLedger }, computers: { kinds: KINDS, providers: { orgo: () => provider }, keyOf: async (name) => KEYS[name] }, now: () => Date.now() });
  store.settings.putIfAbsent = putIfAbsent;
  const orgo = swept.find((one) => one.provider === "orgo").swept;
  assert.equal(orgo.ok, false);
  assert.match(orgo.error.message, /wants its computer again, so it is kept/);
  assert.equal(computers.get("c-1").state, "stopped", "kept, as it was");
  assert.equal((await agentComputerOf(store, "agent-1")).state, "detached", "its record stands");
  assert.equal(store.rows.has("agent_computer_hold:agent-1"), false, "the janitor's hold is let go");
});

test("a janitor sweep that deletes an agent's computer an earlier delete failed on clears the agent's record of it", async () => {
  const { store, computers, provider, claim } = await setup();
  await (await claim("run-1")).release();
  store.agents.archive("agent-1");
  const refusing = { release: async () => ({ ok: false, error: { code: "vendor", message: "Orgo answered 503" } }) };
  await reconcileAgentComputer(store, "agent-1", async () => refusing);
  assert.equal((await agentComputerOf(store, "agent-1")).state, "deleting");
  const swept = await sweepServerComputers({ store: { ...store, runs: { ...store.runs, list: async () => [], heldAt: async () => undefined }, computerLedger: store.computerLedger }, computers: { kinds: KINDS, providers: { orgo: () => provider }, keyOf: async (name) => KEYS[name] }, now: () => Date.now() });
  assert.deepEqual(swept.find((one) => one.provider === "orgo").swept, { ok: true, value: { deleted: ["computer-c-1"], kept: 0 } });
  assert.equal(computers.size, 0);
  assert.equal(await agentComputerOf(store, "agent-1"), undefined, "the view shows no computer");
  assert.equal(store.rows.has("agent_computer_hold:agent-1"), false, "the janitor's hold is let go");
});

test("computer.persistent: a boolean, refused (422 not_allowed) where the selected configuration keeps no computer", () => {
  assert.deepEqual(computerIssues(PERSISTENT, "computer"), []);
  assert.deepEqual(computerIssues({ ...PERSISTENT, image: "linux" }, "computer"), []);
  assert.deepEqual(computerIssues({ ...PERSISTENT, persistent: false }, "computer"), []);
  const [docker] = computerIssues({ kind: "sandbox", provider: "docker", persistent: true }, "computer");
  assert.deepEqual([docker.field, docker.reason], ["computer.persistent", "not_allowed"]);
  assert.match(docker.message, /keeps no computer for an agent between runs/);
  const [shape] = computerIssues({ ...PERSISTENT, persistent: "yes" }, "computer");
  assert.deepEqual([shape.field, shape.reason], ["computer.persistent", "wrong_type"]);
  assert.deepEqual(computerIssues({ kind: "none", persistent: true }, "computer").map(({ reason }) => reason), ["not_allowed"], "no computer keeps nothing");
});

test("the claim refuses a persistent setting on a configuration that keeps none, in words, with nothing made", async () => {
  const { calls } = await setup();
  const root = scratch();
  const store = memoryStore({ kind: "sandbox", provider: "docker", persistent: true });
  await assert.rejects(
    computerForClaim({ runId: "run-1", epoch: 1, agentId: "agent-1", computer: { kind: "sandbox", provider: "docker", persistent: true } }, store, { mode: 1, kinds: KINDS, sealKey: randomBytes(32), providers: {}, spec: SPEC, workspace: localWorkspace(root), check: { readBackOf, epoch: 1 } }),
    (error) => error.code === "computer_unavailable" && /keeps no computer for an agent between runs/.test(error.message),
  );
  assert.deepEqual(calls, []);
});
