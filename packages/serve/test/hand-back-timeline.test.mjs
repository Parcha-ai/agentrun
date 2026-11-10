// A browser hand-over on the runner's path shows exactly the rows main shows for the same action. Main's rows are a
// capture (fixtures/hand-back-main-rows.json): main's browser-person wrote the entries for a person's hand-back (done),
// a cancel and an expiry, and main's timelineOf showed them; and the real sign-in case, main's own timeline test's
// entries. Here the same actions run on this build's runner path: the run's process (browser-person, its answers in the
// journal) writes the ask and its rows, and the person's answer is the hand-over entry the runner's loop commits for a
// browser_hand_back row (runner/hand-back.ts). The timeline over those entries must give main's rows: one row for the
// hand-back, never "You signed in", which stays a real sign-in's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { timelineOf } from "@parcha/pi-durable-agent/timeline";
import { pendingOfWaiting, personHands } from "../dist/browser-person.js";
import { handBackOf } from "../dist/runner/hand-back.js";
import { scratch } from "./support.mjs";

const MAIN = JSON.parse(readFileSync(new URL("./fixtures/hand-back-main-rows.json", import.meta.url), "utf8"));
const ASK = { requestId: "00000000-0000-4000-8000-000000000001", sessionTag: MAIN.session, instruction: MAIN.instruction, completionCondition: "the portal shows the account" };
const rowsOf = (entries) => timelineOf(entries).map((row) => [row.kind, row.summary, row.session ?? null]);

/** The run's journal (its root's entries, in order) and its process on the runner's path, sharing it. */
function runnerPath(root) {
  const entries = [];
  let id = 100;
  const append = (kind, data) => entries.push({ kind, id: id++, conversationId: 1, data });
  const hands = () => personHands({
    root, gates: () => ({ give: () => false }), pollMs: 60_000,
    personTime: async () => ({ drop() {} }),
    note: async (kind, data) => void append(kind, data),
    answered: async (ask) => {
      const first = entries.find((entry) => entry.kind === "agent.handover" && entry.data.id === ask && entry.data.state !== "waiting");
      return first && { outcome: first.data.state, at: first.data.at };
    },
    // The ask is its waiting entry in the journal: no record file on this path.
    asked: async (ask) => entries.map((entry) => (entry.kind === "agent.handover" ? pendingOfWaiting(entry.data, ask) : undefined)).find(Boolean),
  });
  /** The runner's loop applying a person's browser_hand_back row, sent now: the entry it commits. */
  const handBack = (ask, outcome) => {
    const { write, refused } = handBackOf(entries, { ask, outcome }, Date.now());
    assert.equal(refused, undefined, "the person's answer is taken");
    append("agent.handover", write);
  };
  return { entries, hands, handBack };
}

for (const outcome of ["done", "cancelled"]) {
  test(`a person's hand-back (${outcome}) on the runner's path shows main's rows for it`, async (t) => {
    const root = await scratch(t);
    const run = runnerPath(root);
    const person = run.hands();
    t.after(() => person.close());
    const { interactionId } = await person.handoff.request(ASK);
    run.handBack(interactionId, outcome);
    assert.equal(await person.handoff.outcome(interactionId), outcome, "the agent's wait hears it");
    assert.deepEqual(rowsOf(run.entries), MAIN.cases[outcome]);
  });
}

test("an expiry on the runner's path shows main's rows for it", async (t) => {
  const root = await scratch(t);
  const run = runnerPath(root);
  const before = run.hands();
  const { interactionId } = await before.handoff.request(ASK);
  before.close();
  // Past its expiry when the run's next process reads it, as main's capture did: its waiting entry, the ask's one record.
  run.entries.find((entry) => entry.kind === "agent.handover" && entry.data.id === interactionId && entry.data.state === "waiting").data.expires_at = new Date(Date.now() - 1000).toISOString();
  const after = run.hands();
  t.after(() => after.close());
  assert.equal(await after.handoff.outcome(interactionId), "expired");
  assert.deepEqual(rowsOf(run.entries), MAIN.cases.expired);
});

test("a real sign-in (a done hand-over entry naming its session alone) still shows main's \"You signed in\"", async (t) => {
  const root = await scratch(t);
  const run = runnerPath(root);
  const person = run.hands();
  t.after(() => person.close());
  await person.handoff.request(ASK);
  run.entries.push({ kind: "agent.handover", id: 900, conversationId: 1, data: { state: "done", session: MAIN.session } });
  assert.deepEqual(rowsOf(run.entries), MAIN.cases.signedIn);
});
