// A run's saved browser sign-in on the runner path (sign-ins-store.ts runSignIn, as tools.ts's browser binding calls it
// when its host carries the run's store, claim and seal key): the runner is one process holding many claims, so each
// run's sign-in is read from the store under that run's own claim, never from the process's environment, its secrets'
// pipe or any state the process shares. Each run gets its own agent's pointer and never another's; a run whose agent
// has none gets none, whatever another run on the same runner holds; a stale or lost claim reads none; the hash written
// to the run's sign_in_handed is the hash of what its provider got. The pointer is in no environment, no log line, no
// error and no row in the clear. Bound through the faux browser (fixtures/faux-browser.mjs), which logs the sign-in it
// is handed and whether its ref is anywhere in an environment.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { withEnv } from "./support.mjs";

const signIns = await import("../dist/sign-ins-store.js");
const { pointerHash, saveSignIn } = signIns;
const tools = await import("../dist/tools.js");
const { TOOLS, FAUX_BROWSER_ENV } = tools;
const { FAUX_ENV } = await import("../dist/model.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { hostLifecycle } = await import("../dist/runner/adapter-loop.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
/** A test seal key, no real one. */
const KEY = randomBytes(32);
const LEASE = 60_000;
const pointer = (what) => `${what}-${randomBytes(12).toString("hex")}`;
/** Every file under `dir`, path and bytes. */
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [[path, readFileSync(path)]] : [];
});

/** One runner's store with agents a (a Browserbase context saved), b (a Kernel profile saved) and c (none), one run each
 *  (and a second run of a), every run claimed by the one runner. */
async function runner(t) {
  const s = await storeOn(t);
  const log = join(s.dir, "browser.jsonl");
  writeFileSync(log, "");
  withEnv(t, { FAUX_BROWSER_LOG: log }, ["FAUX_BROWSER_LOG"]);
  const refs = { a: pointer("bb-context"), b: pointer("kernel-profile") };
  for (const agent of ["a", "b", "c"]) await s.store.agents.create({ id: `agent-${agent}`, name: agent }, { id: `rev-${agent}`, kind: "agentic", body: { instructions: "Browse.", tools: ["browser"] } });
  await saveSignIn(s.store, KEY, { agentId: "agent-a", provider: "browserbase", pointer: refs.a });
  await saveSignIn(s.store, KEY, { agentId: "agent-b", provider: "kernel", pointer: refs.b });
  const claims = {};
  for (const [run, agent] of [["run-a", "a"], ["run-b", "b"], ["run-c", "c"], ["run-a2", "a"]]) {
    await s.store.runs.create({ id: run, agentId: `agent-${agent}`, revisionId: `rev-${agent}` });
    claims[run] = await s.store.claim(run, "runner-1", { leaseMs: LEASE });
    assert.ok(claims[run], `${run} claimed`);
  }
  /** The sign-in lines the faux browser logged since `from` (a line count), and the count now. */
  const signInLines = (from = 0) => {
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { lines: lines.slice(from).filter((line) => line.op === "sign-in"), count: lines.length };
  };
  /** Binds the browser tool for `run` as the runner's host does: its store, its claim, the seal key, on `vendor`. */
  const bind = async (run, vendor, claim = claims[run]) => {
    const root = join(s.dir, "runs", run);
    mkdirSync(join(root, "work"), { recursive: true });
    const env = { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER, [TOOL_PLANE_ENV]: JSON.stringify({ browser: vendor }) };
    const host = { where: { root, work: join(root, "work"), ref: { id: run } }, env, install() {}, onConversation() {}, beforeResume() {}, beforeRelease() {}, handoverInJournal: true, store: s.store, claim, sealKey: KEY };
    const before = signInLines().count;
    await TOOLS.browser.bind(host);
    return { env, lines: signInLines(before).lines };
  };
  return { ...s, log, refs, claims, bind };
}

/** Everything the process writes to its own output and console while `work` runs. */
async function said(work) {
  const out = [];
  const write = (stream) => { const original = stream.write; stream.write = function (chunk, ...rest) { out.push(String(chunk)); return original.call(this, chunk, ...rest); }; return () => (stream.write = original); };
  const undo = [write(process.stdout), write(process.stderr)];
  try {
    return { value: await work(), out };
  } finally {
    for (const back of undo) back();
  }
}

test("one runner, many claims: each run's browser gets its own agent's saved sign-in from the store, never another run's, and a run whose agent has none gets none while the others hold theirs", async (t) => {
  const r = await runner(t);
  const { value: bound, out } = await said(async () => ({ a: await r.bind("run-a", "browserbase"), b: await r.bind("run-b", "kernel"), c: await r.bind("run-c", "browserbase") }));
  assert.deepEqual(bound.a.lines, [{ op: "sign-in", provider: "browserbase", ref: r.refs.a, save: true, ref_in_env: false }], "run-a: its agent's Browserbase context");
  assert.deepEqual(bound.b.lines, [{ op: "sign-in", provider: "kernel", ref: r.refs.b, save: true, ref_in_env: false }], "run-b: its agent's Kernel profile");
  assert.deepEqual(bound.c.lines, [], "run-c: its agent saved none, so none, while run-a and run-b hold theirs");
  // The pointer is in no environment: the process's, or any the provider got; nothing the process said names it.
  for (const ref of Object.values(r.refs)) {
    assert.ok(!Object.values(process.env).some((value) => String(value).includes(ref)), "not in process.env");
    for (const { env } of Object.values(bound)) assert.ok(!Object.values(env).some((value) => String(value).includes(ref)), "not in a run's env");
    assert.ok(!out.join("").includes(ref), "no log line names it");
  }
  // What each run was handed, by hash alone, matches what its provider got; run-c's is none.
  assert.deepEqual((await r.store.runs.get("run-a")).signInHanded, [pointerHash(r.refs.a)]);
  assert.deepEqual((await r.store.runs.get("run-b")).signInHanded, [pointerHash(r.refs.b)]);
  assert.ok(!(await r.store.runs.get("run-c")).signInHanded?.length, "run-c was handed none");
  // No row and no file holds a pointer in the clear (the store's journal and run rows among them).
  for (const ref of Object.values(r.refs)) assert.deepEqual(filesUnder(r.dir).filter(([path, bytes]) => path !== r.log && bytes.includes(ref)).map(([path]) => path), [], "no file but the faux browser's own probe log");
});

test("a second run of the same agent on the same runner gets the same sign-in to read, not to save, while the first holds it", async (t) => {
  const r = await runner(t);
  assert.equal((await r.bind("run-a", "browserbase")).lines[0]?.save, true);
  const second = await r.bind("run-a2", "browserbase");
  assert.deepEqual(second.lines, [{ op: "sign-in", provider: "browserbase", ref: r.refs.a, save: false, ref_in_env: false }]);
  assert.deepEqual((await r.store.runs.get("run-a2")).signInHanded, [pointerHash(r.refs.a)]);
});

test("a run on a vendor its agent saved no sign-in for gets none", async (t) => {
  const r = await runner(t);
  assert.deepEqual((await r.bind("run-a", "kernel")).lines, [], "agent a saved a Browserbase context, not a Kernel profile");
  assert.ok(!(await r.store.runs.get("run-a")).signInHanded?.length);
});

test("a stale or lost claim reads no sign-in, and writes no hand", async (t) => {
  const r = await runner(t);
  // Lapsed: the lease ran out on the store's clock, nobody took the run since.
  r.clock.now += LEASE + 1;
  assert.deepEqual((await r.bind("run-a", "browserbase")).lines, [], "a lapsed claim");
  assert.ok(!(await r.store.runs.get("run-a")).signInHanded?.length, "and nothing written");
  // Lost: another runner took the run at a newer epoch; the old claim reads none, the new one reads its own.
  const taken = await r.store.claim("run-a", "runner-2", { leaseMs: LEASE });
  assert.ok(taken && taken.epoch > r.claims["run-a"].epoch);
  assert.deepEqual((await r.bind("run-a", "browserbase", r.claims["run-a"])).lines, [], "a lost claim");
  assert.equal((await r.bind("run-a", "browserbase", taken)).lines[0]?.ref, r.refs.a, "the claim that holds the run reads it");
});

test("runSignIn: the run's agent's pointer for the vendor under the claim, or none: no seal key, another key, a local Chrome, a stale claim; and a sign-in forgotten while the hand is written is never handed", async (t) => {
  const r = await runner(t);
  const { runSignIn } = signIns;
  assert.equal(typeof runSignIn, "function", "sign-ins-store.ts exports runSignIn");
  assert.deepEqual(await runSignIn(r.store, KEY, r.claims["run-a"], "browserbase"), { provider: "browserbase", ref: r.refs.a, save: true });
  assert.equal(await runSignIn(r.store, undefined, r.claims["run-b"], "kernel"), undefined, "no seal key");
  assert.equal(await runSignIn(r.store, randomBytes(32), r.claims["run-b"], "kernel"), undefined, "another key: it does not open");
  assert.equal(await runSignIn(r.store, KEY, r.claims["run-b"], "chrome"), undefined, "a local Chrome keeps none");
  assert.equal(await runSignIn(r.store, KEY, r.claims["run-c"], "browserbase"), undefined, "its agent has none");
  // A forget that lands between the read and the hand: the store moved the pointer to a tombstone, so it is not handed.
  const racing = { ...r.store, runs: { ...r.store.runs, update: async (...args) => { await r.store.signIns.forget("agent-b", "kernel", { hash: "not-this-one" }); return r.store.runs.update(...args); } } };
  assert.equal(await runSignIn(racing, KEY, r.claims["run-b"], "kernel"), undefined, "forgotten meanwhile: none");
  r.clock.now += LEASE + 1;
  const stale = await runSignIn(r.store, KEY, r.claims["run-a2"], "browserbase").then((value) => ({ value }), (error) => ({ error }));
  assert.deepEqual(stale, { value: undefined }, "a stale claim: none, never a throw");
});

/** The agent's sign-in for `provider` as the agent's sign-ins API shows it. */
const viewOf = async (store, agentId, provider) => (await signIns.signInViews(store, KEY, agentId)).find((view) => view.provider === provider);
/** A session's row as pi-browser hands its change: released by the run (`reason`), at `endedAt`. */
const released = (reason = "close", endedAt = "2026-11-09T10:15:30.000Z", resourceId = "bb-session-1") => ({ session: { tag: "ar-1", resourceId, releaseReason: reason, endedAt } });

test("a runner-path run that saves its sign-in fills its verified_at with the save's own time, as the lease's end does on main", async (t) => {
  const r = await runner(t);
  assert.equal(typeof tools.runSignInSaved, "function", "tools.ts exports runSignInSaved");
  const kept = await signIns.runSignIn(r.store, KEY, r.claims["run-a"], "browserbase");
  assert.equal(kept.save, true);
  assert.equal((await viewOf(r.store, "agent-a", "browserbase")).verified_at, null, "not verified yet");
  const saved = tools.runSignInSaved(r.store, KEY, r.claims["run-a"], kept);
  assert.equal(await saved(released("close", "2026-11-09T10:15:30.000Z"), "released"), true);
  assert.equal((await viewOf(r.store, "agent-a", "browserbase")).verified_at, "2026-11-09T10:15:30.000Z", "the save's own time, not the clock's");
  assert.equal(await saved(released("idle", "2026-11-09T10:20:00.000Z"), "released"), true, "a later save moves it");
  assert.equal((await viewOf(r.store, "agent-a", "browserbase")).verified_at, "2026-11-09T10:20:00.000Z");
});

test("a run that saved nothing leaves verified_at as it was: no save asked, a session the vendor lost or never made, a change that is no release", async (t) => {
  const r = await runner(t);
  const first = await signIns.runSignIn(r.store, KEY, r.claims["run-a"], "browserbase");
  const second = await signIns.runSignIn(r.store, KEY, r.claims["run-a2"], "browserbase");
  assert.equal(second.save, false, "run-a2 reads, run-a saves");
  const reader = tools.runSignInSaved(r.store, KEY, r.claims["run-a2"], second);
  assert.equal(await reader(released(), "released"), false, "a run that did not ask to save");
  const saver = tools.runSignInSaved(r.store, KEY, r.claims["run-a"], first);
  for (const [row, change] of [[released("lost"), "released"], [released("create_failed"), "released"], [released("close", "2026-11-09T10:15:30.000Z", null), "released"], [released(), "live"], [{ session: { tag: "ar-1", resourceId: "bb-session-1", releaseReason: null, endedAt: null } }, "released"]]) {
    assert.equal(await saver(row, change), false, `${JSON.stringify(row.session)} ${change}: no save`);
  }
  assert.equal((await viewOf(r.store, "agent-a", "browserbase")).verified_at, null, "unchanged");
});

test("a run cannot verify another agent's sign-in, nor with a stale or lost claim", async (t) => {
  const r = await runner(t);
  const a = await signIns.runSignIn(r.store, KEY, r.claims["run-a"], "browserbase");
  // Another run's claim, handed agent a's sign-in by hand: its agent is b, which saved no such pointer.
  assert.equal(await signIns.verifyRunSignIn(r.store, KEY, r.claims["run-b"], a, Date.parse("2026-11-09T10:15:30.000Z")), false, "another claim");
  assert.equal(await signIns.verifyRunSignIn(r.store, KEY, r.claims["run-c"], a, Date.parse("2026-11-09T10:15:30.000Z")), false, "a run never handed it");
  assert.equal((await viewOf(r.store, "agent-a", "browserbase")).verified_at, null);
  const b = await signIns.runSignIn(r.store, KEY, r.claims["run-b"], "kernel");
  // Stale: the lease ran out; lost: another runner took the run since.
  r.clock.now += LEASE + 1;
  assert.equal(await tools.runSignInSaved(r.store, KEY, r.claims["run-a"], a)(released(), "released"), false, "a lapsed claim");
  const taken = await r.store.claim("run-b", "runner-2", { leaseMs: LEASE });
  assert.ok(taken);
  assert.equal(await tools.runSignInSaved(r.store, KEY, r.claims["run-b"], b)(released(), "released"), false, "a lost claim");
  assert.equal((await viewOf(r.store, "agent-a", "browserbase")).verified_at, null);
  assert.equal((await viewOf(r.store, "agent-b", "kernel")).verified_at, null);
  // A sign-in saved afresh since the run was handed the old one is not the one it saved: not verified by it.
  const fresh = await r.store.claim("run-a", "runner-2", { leaseMs: LEASE });
  const handed = await signIns.runSignIn(r.store, KEY, fresh, "browserbase");
  await signIns.saveSignIn(r.store, KEY, { agentId: "agent-a", provider: "browserbase", pointer: pointer("bb-context-new") });
  assert.equal(await signIns.verifyRunSignIn(r.store, KEY, fresh, handed, Date.parse("2026-11-09T10:15:30.000Z")), false, "a pointer replaced since");
  assert.equal((await viewOf(r.store, "agent-a", "browserbase")).verified_at, null);
});

test("bound through a host whose lifecycle is the adapter loop's hostLifecycle(), the browser registers exactly one of each hook, and the run's sign-in is read at bind, before any of them runs", async (t) => {
  const r = await runner(t);
  const lifecycle = hostLifecycle();
  const root = join(r.dir, "runs", "run-a");
  mkdirSync(join(root, "work"), { recursive: true });
  const env = { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER, [TOOL_PLANE_ENV]: JSON.stringify({ browser: "browserbase" }) };
  const host = { where: { root, work: join(root, "work"), ref: { id: "run-a" } }, env, install() {}, ...lifecycle.register, handoverInJournal: true, store: r.store, claim: r.claims["run-a"], sealKey: KEY };
  const before = readFileSync(r.log, "utf8").split("\n").filter(Boolean).length;
  await TOOLS.browser.bind(host);
  assert.deepEqual([lifecycle.onConversation.length, lifecycle.beforeResume.length, lifecycle.beforeRelease.length], [1, 1, 1], "one of each, collected for the loop");
  const read = readFileSync(r.log, "utf8").split("\n").filter(Boolean).slice(before).map((line) => JSON.parse(line)).filter((line) => line.op === "sign-in");
  assert.deepEqual(read, [{ op: "sign-in", provider: "browserbase", ref: r.refs.a, save: true, ref_in_env: false }], "the run's sign-in, read at bind, with no hook run yet");
  assert.deepEqual((await r.store.runs.get("run-a")).signInHanded, [pointerHash(r.refs.a)]);
});

test.todo("a runner-path run's browser opens its sessions on the handed sign-in end to end through the adapter loop (a session's profile, its viewer handed over, its save on release and the sign-in's verified_at): waits on E2r3: the runner's ToolHost built with hostLifecycle().register (adapter-run-spec.ts host, today no-op hooks) and spec.lifecycle passed to the adapter loop; and on the host tool's api giving the browser's calls the tool task's own members (memo, snapshot, waitForTask, conversation, taskId), which HOST_API_MEMBERS does not");
