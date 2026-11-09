// What a waiting run's `pending` card serves (store-view.ts), in its view and in both run lists, is cut by the run's one
// cut (run-cut.ts) as every other word it says: a question its turn ended on and an approval's argument preview hold no
// secret this server keeps and no sign-in pointer the run was handed; a run whose hand can't be read back here serves no
// pending at all (its words are withheld). Built in a temp store, the waiting row written to the journal as the runner
// writes it: the in-process runner can't park on ask_person end to end today.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { saveSignIn, signInsOverStore } from "../dist/sign-ins-store.js";
import { storeOn, T0 } from "./store-helpers.mjs";

const { viewOverStore, summaryOverStore } = await import("../dist/store-view.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const SEAL = randomBytes(32);
const KEY = ["not-a-secret", "pending-key", randomBytes(6).toString("hex")].join("-");
const POINTER = `bb-ctx-PENDING-${randomBytes(10).toString("hex")}`;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const vendors = { remove: async () => undefined };
const depsOf = (store) => ({ origin: "https://run.test", serverSecrets: () => [KEY], signIns: signInsOverStore(store, SEAL, vendors) });

/** Agent alpha, its Browserbase sign-in POINTER saved, and run-1 launched on a Browserbase plane and claimed. */
async function waiting(t) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "alpha", name: "Alpha" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await saveSignIn(store, SEAL, { agentId: "alpha", provider: "browserbase", pointer: POINTER });
  await store.runs.create({ id: "run-1", agentId: "alpha", revisionId: "rev-1" }, { body: { input: { message: "Help me." }, title: "Ask run", place: { mode: "runner" }, plane: { browser: "browserbase" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  return { store, claim };
}

/** The run's turn ended on `call` (a tool call), with `also` entries after it, written to its journal; then let go. */
async function endedOn(store, claim, call, also = []) {
  const journal = store.journal(claim);
  const u = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Help me.", timestamp: T0 }] };
  const a = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "c1", ...call }], usage: { cost: { total: 0.01 } }, timestamp: T0 + 1_000 }] };
  const more = [];
  for (const entry of also) more.push({ id: await journal.mintId(), conversationId: ROOT, ...entry });
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: u }, { type: "entry", value: a }, ...more.map((value) => ({ type: "entry", value }))], context);
}

/** The run's pending card in its view and in a list's row. */
async function pendings(store) {
  const deps = depsOf(store);
  return { view: (await viewOverStore(store, "run-1", deps)).pending, summary: (await summaryOverStore(store, "run-1", deps)).pending };
}

const holds = (value, needle) => JSON.stringify(value ?? null).includes(needle);

test("a question the run's turn ended on, holding a key this server keeps and the pointer it was handed, is served cut in its view and its list row", async (t) => {
  const { store, claim } = await waiting(t);
  await store.runs.update(claim, { signInHanded: [sha(POINTER)] });
  const question = `Which account? I hold ${KEY} and I saw ${POINTER} on the page.`;
  await endedOn(store, claim, { name: "ask_person", arguments: { question } }, [
    { kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }], timestamp: T0 + 2_000 }] },
  ]);
  await store.release(claim);
  const { view, summary } = await pendings(store);
  for (const [where, pending] of Object.entries({ view, summary })) {
    assert.equal(pending?.kind, "question", `${where}: ${JSON.stringify(pending)}`);
    assert.equal(pending.question, "Which account? I hold [redacted] and I saw [redacted] on the page.", where);
    assert.ok(!holds(pending, KEY) && !holds(pending, POINTER), `${where}: ${JSON.stringify(pending)}`);
  }
});

test("an approval's argument preview holding a key this server keeps is served cut in its view and its list row", async (t) => {
  const { store, claim } = await waiting(t);
  const args = { url: `https://example.test/?k=${KEY}` };
  await endedOn(store, claim, { name: "web_fetch", arguments: args }, [
    { kind: "agentrun.ask", data: { callId: "c1", tool: "web_fetch", args, requestedAt: new Date(T0 + 1_500).toISOString(), price: 0.02 } },
  ]);
  await store.release(claim);
  const { view, summary } = await pendings(store);
  for (const [where, pending] of Object.entries({ view, summary })) {
    assert.equal(pending?.kind, "approval", `${where}: ${JSON.stringify(pending)}`);
    assert.ok(!holds(pending, KEY), `${where}: ${JSON.stringify(pending)}`);
    assert.match(pending.args_preview, /\[redacted\]/, where);
  }
});

test("a run whose hand can't be read back serves no pending card: its question is withheld with its words, in its view and its list row", async (t) => {
  const { store, claim } = await waiting(t);
  // Handed a pointer this server keeps nothing of: what it was handed can't be read back, so the run is withheld.
  await store.runs.update(claim, { signInHanded: [sha("a pointer this server never kept")] });
  await endedOn(store, claim, { name: "ask_person", arguments: { question: `Which account? I saw ${POINTER} on the page.` } }, [
    { kind: "pi.tool-result", model: [{ role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }], timestamp: T0 + 2_000 }] },
  ]);
  await store.release(claim);
  const deps = depsOf(store);
  const view = await viewOverStore(store, "run-1", deps);
  assert.equal(view.status, "input_required", "it still waits");
  const { view: pending, summary } = await pendings(store);
  assert.deepEqual([pending, summary], [null, null]);
  assert.ok(!holds(view, POINTER) && !holds(view, "Which account"), JSON.stringify(view));
});
