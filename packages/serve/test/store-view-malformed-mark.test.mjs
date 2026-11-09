// A sign_in_handed mark the server never writes fails closed in the store-backed run view (store-view.ts viewOverStore
// and summaryOverStore, through handed-values.ts handedValuesOf, by run-view.ts handedMark, main's one rule): a legacy
// `true`, a bare hash, an object, the empty array, and an array holding anything but a hash each read as unreadable, so
// the run is withheld and its answer, which repeats a pointer the agent's sign-in holds, is never served. A well-formed
// mark still serves the answer cut of the pointer. (tl-browser's probe-malformed, kept with its assertion, over the
// store-backed view: on this base the server's own routes still read runs from their files.)
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { viewOverStore, summaryOverStore } = await import("../dist/store-view.js");
const { saveSignIn, signInsOverStore } = await import("../dist/sign-ins-store.js");

const KEY = randomBytes(32);
const ROOT = 1;

test("malformed sign_in_handed marks in the store-backed run view: each withholds the run, none serves the pointer", async (t) => {
  const { store, file } = await storeOn(t);
  await store.agents.create({ id: "alpha", name: "alpha" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  const pointer = `bb-ctx-PROBE-${randomBytes(10).toString("hex")}`;
  await saveSignIn(store, KEY, { agentId: "alpha", provider: "browserbase", pointer });
  await store.runs.create({ id: "run-1", agentId: "alpha", revisionId: "rev-1" }, { body: { input: { content: "Echo it." }, title: "t", place: { mode: "runner" }, plane: { browser: "browserbase" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const user = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: `Echo ${pointer}` }] };
  const answer = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `I kept ${pointer}` }], usage: { cost: { total: 0 } }, timestamp: 0 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: user }, { type: "entry", value: answer }], BACKGROUND_CONTEXT);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: `I kept ${pointer}`, costUsd: 0, endedAt: T0 + 1_000 });
  const deps = { origin: "https://run.test", serverSecrets: () => [], signIns: signInsOverStore(store, KEY, { remove: async () => {} }) };
  const hash = createHash("sha256").update(pointer).digest("hex");
  /** The run's view and summary as served with sign_in_handed set to `mark` as written. */
  const servedWith = async (mark) => {
    const db = new DatabaseSync(file);
    db.prepare("UPDATE runs SET sign_in_handed = ? WHERE id = ?").run(JSON.stringify(mark), "run-1");
    db.close();
    return JSON.stringify([await viewOverStore(store, "run-1", deps), await summaryOverStore(store, "run-1", deps)]);
  };

  // The well-formed mark: served, cut of the pointer.
  const cut = await servedWith([hash]);
  assert.ok(cut.includes("I kept"), `a well-formed mark serves the answer: ${cut.slice(0, 300)}`);
  assert.ok(!cut.includes(pointer), "cut of the pointer");

  const open = [];
  for (const mark of [true, hash, { hash }, [hash, 5], [hash, "not a hash"], []]) {
    const served = await servedWith(mark);
    t.diagnostic(`${JSON.stringify(mark).slice(0, 30)}: ${served.slice(0, 160)}`);
    if (served.includes(pointer)) open.push(JSON.stringify(mark).slice(0, 30));
  }
  assert.deepEqual(open, [], "marks that fail open");
});
