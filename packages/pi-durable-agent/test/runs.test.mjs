import { AgentDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { AgentHomeError, carryBack, createAgentHome, durableProfileStore, readAgentHome, startRun } from "../dist/index.js";
import { ctx, DEFINITION, openHost, openSession, Profiles, scratch } from "./support.mjs";

const refused = (code) => (error) => error instanceof AgentHomeError && error.code === code;

/** A make that counts its calls. */
function maker(ref) {
  const make = async (signal) => {
    assert.ok(signal instanceof AbortSignal);
    make.calls += 1;
    return ref;
  };
  make.calls = 0;
  return make;
}

/** An agent home whose `acme` profile a first run signed in to. */
async function signedIn() {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  const run = await startRun(home, { runId: "first", host: "test" });
  const session = await openSession(run.storePath);
  await durableProfileStore(session).resolve("acme", maker("ctx_1"));
  await session.close(ctx);
  await carryBack(home, run, { outcome: "completed" });
  return home;
}

/** Change a profile in a run store, as the browser does during a run. */
async function editProfile(storePath, key, fields) {
  const session = await openSession(storePath);
  await session.commit(async (tx) => { Object.assign(await tx.doc(Profiles, key, null), fields); }, ctx);
  await session.close(ctx);
}

test("run 1 makes the sign-in and carries it back; run 2 starts signed in and never makes one", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n", "cite/refs/style.md": "APA\n" } });
  const make = maker("ctx_1");

  const run1 = await startRun(home, { runId: "run-1", host: "test" });
  assert.deepEqual(run1.agent, { instructions: "Cite every claim.", tools: ["web_search", "browser"] });
  assert.deepEqual(run1.leases, []);
  assert.equal(run1.storePath, path.join(home.dir, "runs", "run-1", "run.sqlite"));
  assert.equal(await readFile(path.join(run1.workspace, ".agents/skills/cite/SKILL.md"), "utf8"), "# Cite\n");
  assert.equal(await readFile(path.join(run1.workspace, ".agents/skills/cite/refs/style.md"), "utf8"), "APA\n");

  const host1 = await openHost(run1.storePath);
  await host1.root(ctx, { agent: { instructions: run1.agent.instructions } });
  assert.equal((await host1.snapshot(AgentDoc, ROOT_CONVERSATION_ID, ctx))?.instructions, "Cite every claim.");
  assert.equal(await durableProfileStore(host1).resolve("acme", make), "ctx_1");
  assert.equal(await durableProfileStore(host1).resolve("acme", make), "ctx_1");
  assert.equal(make.calls, 1);
  await host1.close(ctx);

  assert.deepEqual(await carryBack(home, run1, { outcome: "completed", finalAnswer: { answer: "42" }, cost: 0.12 }), { changed: true, profiles: ["acme"], released: [] });
  const after1 = await readAgentHome(home);
  assert.deepEqual(after1.profiles, { acme: { provider: "browserbase", ref: "ctx_1", state: "ready" } });
  const record = after1.runs["run-1"];
  assert.deepEqual({ ...record, startedAt: typeof record.startedAt, endedAt: typeof record.endedAt },
    { path: "runs/run-1", host: "test", startedAt: "string", endedAt: "string", outcome: "completed", finalAnswer: { answer: "42" }, cost: 0.12 });

  const run2 = await startRun(home, { runId: "run-2", host: "test" });
  assert.deepEqual(run2.leases, ["acme"]);
  const host2 = await openHost(run2.storePath);
  assert.equal(await durableProfileStore(host2).resolve("acme", make), "ctx_1");
  assert.equal(make.calls, 1, "run 2 found the sign-in ready");
  await host2.close(ctx);
  assert.deepEqual(await carryBack(home, run2, { outcome: "completed" }), { changed: true, profiles: ["acme"], released: ["acme"] });
  assert.deepEqual((await readAgentHome(home)).leases, {});
});

test("two concurrent runs: only the lease holder writes a profile back, and a new profile goes to the first run that carries it back", async () => {
  const home = await signedIn();
  const [a, b] = [await startRun(home, { runId: "run-a", host: "test" }), await startRun(home, { runId: "run-b", host: "test" })];
  assert.deepEqual([a.leases, b.leases], [["acme"], []]);
  assert.equal((await readAgentHome(home)).leases.acme.runId, "run-a");

  await editProfile(a.storePath, "acme", { ref: "ctx_a", verifiedAt: "2026-10-15T20:00:00.000Z" });
  await editProfile(b.storePath, "acme", { ref: "ctx_b", verifiedAt: "2026-10-15T20:00:01.000Z" });
  await editProfile(b.storePath, "globex", { provider: "browserbase", ref: "ctx_globex_b", state: "ready" });
  await editProfile(a.storePath, "globex", { provider: "browserbase", ref: "ctx_globex_a", state: "ready" });

  const [backB, backA] = await Promise.all([carryBack(home, b, { outcome: "completed" }), carryBack(home, a, { outcome: "failed" })]);
  assert.deepEqual(backB, { changed: true, profiles: ["globex"], released: [] });
  assert.deepEqual(backA, { changed: true, profiles: ["acme"], released: ["acme"] });
  const state = await readAgentHome(home);
  assert.deepEqual(state.profiles, {
    acme: { provider: "browserbase", ref: "ctx_a", state: "ready", verifiedAt: "2026-10-15T20:00:00.000Z" },
    globex: { provider: "browserbase", ref: "ctx_globex_b", state: "ready" },
  });
  assert.deepEqual(state.leases, {});
  assert.deepEqual([state.runs["run-a"].outcome, state.runs["run-b"].outcome], ["failed", "completed"]);
});

test("carryBack twice changes nothing the second time", async () => {
  const home = await signedIn();
  const run = await startRun(home, { runId: "again", host: "test" });
  await editProfile(run.storePath, "acme", { verifiedAt: "2026-10-15T21:00:00.000Z" });
  const first = await carryBack(home, run, { outcome: "completed", cost: 1 });
  assert.equal(first.changed, true);
  const before = await readAgentHome(home);
  await editProfile(run.storePath, "acme", { ref: "ctx_late" });
  assert.deepEqual(await carryBack(home, run, { outcome: "failed", cost: 9 }), { changed: false, profiles: [], released: [] });
  assert.deepEqual(await readAgentHome(home), before);
  await assert.rejects(carryBack(home, { runId: "never-started" }, { outcome: "completed" }), refused("missing"));
});

test("an expired lease passes to the next run, and the run that lost it saves nothing back", async () => {
  const home = await signedIn();
  const t = Date.parse("2026-10-15T20:00:00.000Z");
  const a = await startRun(home, { runId: "slow", host: "test", now: t, leaseMs: 1_000 });
  const b = await startRun(home, { runId: "early", host: "test", now: t + 500 });
  const c = await startRun(home, { runId: "late", host: "test", now: t + 1_500 });
  assert.deepEqual([a.leases, b.leases, c.leases], [["acme"], [], ["acme"]]);
  await editProfile(a.storePath, "acme", { ref: "ctx_slow" });
  assert.deepEqual(await carryBack(home, a, { outcome: "completed", now: t + 1_600 }), { changed: true, profiles: [], released: [] });
  assert.equal((await readAgentHome(home)).profiles.acme.ref, "ctx_1");
  assert.equal((await readAgentHome(home)).leases.acme.runId, "late");
});

test("a run id is used once, and a malformed one is refused", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  const run = await startRun(home, { host: "test" });
  assert.match(run.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  await assert.rejects(startRun(home, { runId: run.runId, host: "test" }), refused("exists"));
  await assert.rejects(startRun(home, { runId: "../escape", host: "test" }), refused("invalid"));
  await assert.rejects(startRun(home, { runId: "ok", host: "" }), refused("invalid"));
  assert.ok(!existsSync(path.join(home.dir, "runs", "ok")));
  assert.deepEqual(Object.keys((await readAgentHome(home)).runs), [run.runId]);
});

test("durableProfileStore makes one ref for concurrent callers, and a make that fails commits nothing", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  const run = await startRun(home, { runId: "profiles", host: "test" });
  const session = await openSession(run.storePath);
  let calls = 0;
  const slow = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 50)); return "ctx_x"; };
  const refs = await Promise.all([durableProfileStore(session).resolve("k", slow), durableProfileStore(session).resolve("k", slow), durableProfileStore(session).resolve("k", slow)]);
  assert.deepEqual(refs, ["ctx_x", "ctx_x", "ctx_x"]);
  assert.equal(calls, 1);

  const store = durableProfileStore(session, { provider: "kernel" });
  await assert.rejects(store.resolve("k2", async () => { throw new Error("vendor down"); }), /vendor down/);
  assert.equal(await session.snapshot(Profiles, "k2", ctx), undefined);
  await assert.rejects(store.resolve("k2", async () => ""), refused("invalid"));
  assert.equal(await store.resolve("k2", async () => "ctx_k2"), "ctx_k2");
  assert.deepEqual(await session.snapshot(Profiles, "k2", ctx), { provider: "kernel", ref: "ctx_k2", state: "ready" });
  await session.close(ctx);
});
