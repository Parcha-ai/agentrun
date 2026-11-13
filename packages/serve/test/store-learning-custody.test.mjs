// A run's learning as the store path serves it (its view's `learning`, its list row's, and GET /runs/{id}/learning's body,
// run-learning-served.ts) is cut by the run's one cut (run-cut.ts), as its words are: every secret this server keeps and
// every sign-in pointer the run was handed. A run whose hand can't be read back here is withheld: its view and list row
// serve no learning, and GET /runs/{id}/learning is refused (403, in the view's words), as its graph and files are. The
// learning rows are written to the store directly (its launch's given notes, its kept learning_proposals row); a workflow
// run can't drive learning on this switch.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { ApiError } from "../dist/errors.js";
import { WITHHELD_SIGN_IN } from "../dist/run-view.js";
import { servedRunLearning } from "../dist/run-learning-served.js";
import { saveSignIn, signInsOverStore } from "../dist/sign-ins-store.js";
import { storeOn } from "./store-helpers.mjs";

const { viewOverStore, summaryOverStore } = await import("../dist/store-view.js");

const SEAL = randomBytes(32);
const KEY = ["not-a-secret", "learning-key", randomBytes(6).toString("hex")].join("-");
const POINTER = `bb-ctx-LEARNING-${randomBytes(10).toString("hex")}`;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const vendors = { remove: async () => undefined };
const depsOf = (store) => ({ origin: "https://run.test", serverSecrets: () => [KEY], signIns: signInsOverStore(store, SEAL, vendors) });

/** Agent alpha (it learns), its Browserbase sign-in POINTER saved, and run-1 launched on a Browserbase plane given a note
 *  whose name holds KEY and POINTER, handed `hand`, ended with its learning kept. */
async function learnedRun(t, hand) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "alpha", name: "Alpha" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", learning: true } });
  await saveSignIn(store, SEAL, { agentId: "alpha", provider: "browserbase", pointer: POINTER });
  const given = [{ file: "account.md", name: `Account ${POINTER} under ${KEY}` }];
  await store.runs.create({ id: "run-1", agentId: "alpha", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, plane: { browser: "browserbase" }, learning: { given, seed: "a".repeat(40), section: "# Learned\n" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { signInHanded: [sha(hand)] });
  await store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "dropped", reason: "empty", detail: "Nothing to keep." } } }] });
  return store;
}

const holds = (value, needle) => JSON.stringify(value ?? null).includes(needle);

test("a readable handed run's learning, its note names holding a key this server keeps and the pointer it was handed, is served cut in its view, its list row and GET /runs/{id}/learning", async (t) => {
  const store = await learnedRun(t, POINTER);
  const deps = depsOf(store);
  const view = (await viewOverStore(store, "run-1", deps)).learning;
  const listed = (await summaryOverStore(store, "run-1", deps)).learning;
  const body = await servedRunLearning(deps, store, "run-1");
  for (const [where, learning] of Object.entries({ view, listed, body })) {
    assert.ok(learning, `${where} serves its learning`);
    assert.equal(learning.given?.[0]?.name, "Account [redacted] under [redacted]", `${where}: ${JSON.stringify(learning.given)}`);
    assert.ok(!holds(learning, POINTER) && !holds(learning, KEY), `${where}: ${JSON.stringify(learning)}`);
  }
});

test("a run whose hand can't be read back serves no learning in its view or its list row, and GET /runs/{id}/learning refuses it in the view's words", async (t) => {
  const store = await learnedRun(t, "a pointer this server never kept");
  const deps = depsOf(store);
  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "completed", "it ended as it ended");
  assert.equal(view.learning, null);
  assert.equal((await summaryOverStore(store, "run-1", deps)).learning, null);
  await assert.rejects(servedRunLearning(deps, store, "run-1"), (error) => error instanceof ApiError && error.code === "forbidden" && error.message === WITHHELD_SIGN_IN);
  assert.ok(!holds(view, POINTER) && !holds(view, KEY), JSON.stringify(view.learning));
});
