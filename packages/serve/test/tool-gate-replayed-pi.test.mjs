// On pi, a replay-safe tool (web_fetch, read, web_search) that a crash cut is run again by pi-durable's recovery with
// the SAME call id, through the gate's wrap, and pi gives the tool no sign that it is a rerun. If the gate let the first
// attempt through, that attempt may have been sent and billed: a deny on the rerun says whether it took effect is not
// known, never "nothing was sent and nothing was charged". A call the gate never let through keeps NOT_RUN, which is
// true: nothing of it left. The gate keeps its own mark of a call it let through, in the run's store, for a tool that can
// bill only (web_fetch, web_search): a free one (read) leaves no mark.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { GATE_PASSED_ENTRY, NOT_RUN, RunGate } from "../dist/tool-gate.js";
import { scratch } from "./support.mjs";

const UNKNOWN = "It had started before the deny, and whether it took effect is not known.";

/** A pi run's process on `storage` (the same storage: the next process, after a crash), with web_fetch set to
 *  `permission` on the server (`tool`, replay-safe: web_fetch by default); `sent` counts the tool's own runs. */
async function processOn(t, { storage = new MemoryStorage(), where, permission, tool = "web_fetch" }) {
  const harness = await Harness.open(storage, { registry: createRegistry(), models: {} }, ctx);
  await harness.root(ctx);
  const dirs = where ?? { root: await scratch(t), work: await scratch(t), data: await scratch(t) };
  await writeFile(join(dirs.data, "tool-settings.json"), JSON.stringify({ [tool]: { permission } }));
  const gate = new RunGate({ ...dirs, runId: "r1", harness: "pi" });
  await gate.load({ harness }, ctx);
  const sent = [];
  const registration = { name: tool, description: tool, parameters: {}, replay: "safe", execute: async () => (sent.push(1), { content: [{ type: "text", text: "fetched" }] }) };
  const wrapped = gate.extension([registration]).wraps.find((wrap) => wrap.tool === tool).wrap(registration);
  const call = async (callId) => {
    const result = await wrapped.execute({ url: "https://paid.example/" }, { callId, commit: (change) => harness.commit(change, ctx) }, ctx);
    return (result.content ?? result.output ?? []).map((block) => block.text ?? "").join("");
  };
  return { storage, where: dirs, call, sent, harness };
}

test("a pi rerun of a call the gate let through, now denied, says whether it took effect is not known", async (t) => {
  const first = await processOn(t, { permission: "allow" });
  assert.equal(await first.call("call_1"), "fetched");
  assert.equal(first.sent.length, 1, "the first attempt ran (and may have been billed)");
  // The process goes before the result commits; the next one runs the same call id again, now denied.
  const next = await processOn(t, { storage: first.storage, where: first.where, permission: "deny" });
  const text = await next.call("call_1");
  assert.ok(text.includes(UNKNOWN) && !text.includes(NOT_RUN), text);
  assert.equal(next.sent.length, 0, "the rerun is not run");
});

test("a call the gate never let through keeps NOT_RUN when denied, in a fresh process or after a restart", async (t) => {
  const first = await processOn(t, { permission: "deny" });
  const once = await first.call("call_2");
  assert.ok(once.includes(NOT_RUN), once);
  const next = await processOn(t, { storage: first.storage, where: first.where, permission: "deny" });
  const again = await next.call("call_2");
  assert.ok(again.includes(NOT_RUN) && !again.includes(UNKNOWN), again);
});

test("a replay-safe tool that cannot bill (read) is never marked: its root gains no entry, and its rerun under deny keeps NOT_RUN", async (t) => {
  const first = await processOn(t, { permission: "allow", tool: "read" });
  assert.equal(await first.call("call_3"), "fetched");
  const root = await first.harness.conversation(ROOT_CONVERSATION_ID, ctx);
  const kinds = root ? (await root.entries({ order: "ascending" }, 500, undefined, ctx)).items.map((entry) => entry.kind) : [];
  assert.deepEqual(kinds.filter((kind) => kind === GATE_PASSED_ENTRY), [], "no mark for a free call");
  const next = await processOn(t, { storage: first.storage, where: first.where, permission: "deny", tool: "read" });
  const text = await next.call("call_3");
  assert.ok(text.includes(NOT_RUN), text);
});
