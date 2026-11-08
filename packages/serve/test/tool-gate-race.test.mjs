// The run's gate acts on the owner's answers from one read of serve.json, one call at a time; a stop that overrides an
// answer between that read and the gate's act on it (runs.ts supersede) must win in the live process too: the gate reads
// the answer again just before it acts. Two answered calls on a real store in memory: the test's own resume of the first
// rewrites the second's answer to withdrawn, as a stop would, before the gate reaches it with what it read before.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { APPROVAL_ENTRY, RunGate } from "../dist/tool-gate.js";
import { scratch } from "./support.mjs";

const requested = (id, call) => ({ kind: APPROVAL_ENTRY, data: { phase: "requested", id, tool: "web_fetch", call_id: call, args: { url: `http://public.example/${call}` }, args_preview: "{}", requested_at: new Date().toISOString() } });
const denied = { decision: "deny", answered_at: new Date().toISOString(), args_shown: "{}" };

test("a stop that overrides an answer after the live gate read it and before the gate acts on it wins: the second call is resolved with nothing resumed", async (t) => {
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, ctx);
  await harness.root(ctx);
  await harness.commit(async (tx) => {
    await tx.appendEntry(ROOT_CONVERSATION_ID, requested("ap_first", "c1"));
    await tx.appendEntry(ROOT_CONVERSATION_ID, requested("ap_second", "c2"));
  }, ctx);
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  const meta = join(root, "serve.json");
  await writeFile(meta, JSON.stringify({ approvals: { ap_first: denied, ap_second: denied } }));
  const gate = new RunGate({ root, work, data, runId: "r1" });
  await gate.load({ harness }, ctx);
  const resumed = [];
  gate.start(async (id, _content, mark) => {
    resumed.push(id);
    // While the gate acts on the first, a stop overrides the second (as runs.ts writes it): the gate has read it as deny.
    if (id === "ap_first") {
      const now = JSON.parse(await readFile(meta, "utf8"));
      now.approvals.ap_second = { decision: "withdrawn", answered_at: new Date().toISOString(), superseded: denied };
      await writeFile(meta, JSON.stringify(now));
    }
    await harness.commit(mark, ctx);
  });
  for (const end = Date.now() + 10_000; gate.waiting(); await sleep(25)) assert.ok(Date.now() < end, "both calls resolved");
  await sleep(300);
  assert.deepEqual(resumed, ["ap_first"], "the overridden call resumed nothing");
  const page = await (await harness.conversation(ROOT_CONVERSATION_ID, ctx)).entries({ order: "ascending" }, 100, undefined, ctx);
  assert.deepEqual(page.items.filter((entry) => entry.kind === APPROVAL_ENTRY && entry.data?.phase === "resolved").map((entry) => [entry.data.id, entry.data.decision]), [["ap_first", "deny"], ["ap_second", "withdrawn"]]);
});
