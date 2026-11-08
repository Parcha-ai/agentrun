// The browser person's hand-over over the one store (browser-commands.ts): the agent's ask is a journal entry the runner
// writes, the person's answer a command row. The reader yields the ask the view shows from the journal; the writer answers it
// through the command path, first-wins, in the old route's words. Reader cases are pure (synthetic journal entries and
// commands); the writer writes a command to a real store in a temp dir.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");
const { browserAsk, browserHandBack, handBackTarget, BROWSER_HAND_BACK, BROWSER_HANDOVER_KIND } = await import("../dist/browser-commands.js");

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshStore() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-bc-"));
  dirs.push(dir);
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  after(() => store.close().catch(() => undefined));
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  return store;
}

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const waiting = (id, over = {}) => ({
  kind: BROWSER_HANDOVER_KIND,
  data: { state: "waiting", id, session: "s1", instruction: "Click login", completion_condition: "You are signed in", asked_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 60_000).toISOString(), ...over },
});
const answered = (id, state, at) => ({ kind: BROWSER_HANDOVER_KIND, data: { state, id, ...(at !== undefined ? { at } : {}) } });
const handBackCmd = (ask, outcome, at = NOW) => ({ id: 1, runId: "run-1", kind: BROWSER_HAND_BACK, body: { ask, outcome, at }, createdAt: NOW, takenAt: null, refused: null, tries: 0 });

// ---- reader: browserAsk ---------------------------------------------------------------------------------------------

test("browserAsk yields the waiting ask with its whole record", () => {
  const ask = browserAsk([waiting("ask-1")], [], NOW + 1_000);
  assert.deepEqual(ask, { id: "ask-1", tag: "s1", instruction: "Click login", completion_condition: "You are signed in", asked_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 60_000).toISOString() });
});

test("browserAsk shows no ask once it is answered in the journal", () => {
  assert.equal(browserAsk([waiting("ask-1"), answered("ask-1", "done")], [], NOW + 1_000), undefined);
});

test("browserAsk shows no ask once a person's hand-over command answers it", () => {
  assert.equal(browserAsk([waiting("ask-1")], [handBackCmd("ask-1", "done")], NOW + 1_000), undefined);
});

test("browserAsk shows no ask past its expiry", () => {
  assert.equal(browserAsk([waiting("ask-1")], [], NOW + 120_000), undefined);
});

test("browserAsk shows the newest still-waiting ask", () => {
  const entries = [waiting("ask-1"), waiting("ask-2", { asked_at: new Date(NOW + 5_000).toISOString(), expires_at: new Date(NOW + 65_000).toISOString() })];
  assert.equal(browserAsk(entries, [], NOW + 6_000).id, "ask-2");
});

// ---- reader: handBackTarget -----------------------------------------------------------------------------------------

test("handBackTarget picks the open ask with no answer", () => {
  assert.deepEqual(handBackTarget([waiting("ask-1")], [], NOW + 1_000), { id: "ask-1" });
});

test("handBackTarget reports an answered ask's answer", () => {
  assert.deepEqual(handBackTarget([waiting("ask-1"), answered("ask-1", "cancelled")], [], NOW + 1_000), { id: "ask-1", answer: "cancelled" });
});

test("handBackTarget carries the answer's own time, from the journal entry", () => {
  assert.deepEqual(handBackTarget([waiting("ask-1"), answered("ask-1", "done", NOW + 700)], [], NOW + 1_000), { id: "ask-1", answer: "done", at: NOW + 700 });
});

test("handBackTarget carries the answer's own time, from a person's command", () => {
  assert.deepEqual(handBackTarget([waiting("ask-1")], [handBackCmd("ask-1", "done", NOW + 500)], NOW + 1_000), { id: "ask-1", answer: "done", at: NOW + 500 });
});

test("handBackTarget reports an expired ask as expired", () => {
  assert.deepEqual(handBackTarget([waiting("ask-1")], [], NOW + 120_000), { id: "ask-1", answer: "expired" });
});

test("handBackTarget is undefined when the run asked nothing", () => {
  assert.equal(handBackTarget([], [], NOW), undefined);
});

// ---- writer: browserHandBack ----------------------------------------------------------------------------------------

test("browserHandBack writes one hand-over command carrying the person's answer time", async () => {
  const store = await freshStore();
  const answer = await browserHandBack(store, "run-1", "done", { id: "ask-1" }, NOW + 900);
  assert.deepEqual(answer, { outcome: "done", first: true });
  const rows = await store.commands("run-1", 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, BROWSER_HAND_BACK);
  assert.deepEqual(rows[0].body, { ask: "ask-1", outcome: "done", at: NOW + 900 });
});

test("browserHandBack on a run that asked nothing is 404, nothing written", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => browserHandBack(store, "run-1", "done", undefined),
    (e) => e.code === "not_found" && /has not asked for you in its browser/.test(e.message),
  );
  assert.equal((await store.commands("run-1", 0)).length, 0);
});

test("the same answer again changes nothing (first wins), no new command", async () => {
  const store = await freshStore();
  const answer = await browserHandBack(store, "run-1", "done", { id: "ask-1", answer: "done" });
  assert.deepEqual(answer, { outcome: "done", first: false });
  assert.equal((await store.commands("run-1", 0)).length, 0);
});

test("a different answer to an answered ask is 409 handoff_answered", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => browserHandBack(store, "run-1", "done", { id: "ask-1", answer: "cancelled" }),
    (e) => e.code === "handoff_answered" && /was already answered cancelled\./.test(e.message),
  );
  assert.equal((await store.commands("run-1", 0)).length, 0);
});

test("answering an expired ask is 409 with the expiry words", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => browserHandBack(store, "run-1", "done", { id: "ask-1", answer: "expired" }),
    (e) => e.code === "handoff_answered" && /expired before this answer: the agent was told it expired\./.test(e.message),
  );
});

test("first wins across the command path: once a hand-over command is in, a second answer sees it, with its time", async () => {
  const store = await freshStore();
  await browserHandBack(store, "run-1", "done", { id: "ask-1" }, NOW + 900);
  // The view folds the command into the ask's answer and its time; the writer's target now carries them.
  const target = handBackTarget([waiting("ask-1")], await store.commands("run-1", 0), NOW + 1_000);
  assert.deepEqual(target, { id: "ask-1", answer: "done", at: NOW + 900 });
  const again = await browserHandBack(store, "run-1", "done", target);
  assert.deepEqual(again, { outcome: "done", first: false });
  assert.equal((await store.commands("run-1", 0)).length, 1);
});
