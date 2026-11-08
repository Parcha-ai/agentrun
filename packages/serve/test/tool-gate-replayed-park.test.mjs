// A replay-safe call the kernel runs again after a crash (its first attempt may have been sent and billed) can PARK
// when its tool now asks. The park keeps that it is a replay, in the run's store, so a later refusal (the owner's Deny,
// or a declining message) never says "nothing was sent and nothing was charged", in this process or after a restart.
// A first attempt's refusal keeps the plain NOT_RUN words, and an allowed replay runs as any approved call does.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { APPROVAL_ENTRY, NOT_RUN, RunGate } from "../dist/tool-gate.js";
import { scratch } from "./support.mjs";

const UNKNOWN = "It had started before the deny, and whether it took effect is not known.";
const ARGS = { url: "https://paid.example/report" };

/** A claude-agent run's gate on `storage` (fresh: the first process; the same: the next, after a restart), with web_fetch
 *  set to ask on the server; its resumes recorded. */
async function runOn(t, { storage = new MemoryStorage(), where } = {}) {
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, ctx);
  await harness.root(ctx);
  const dirs = where ?? { root: await scratch(t), work: await scratch(t), data: await scratch(t) };
  await writeFile(join(dirs.data, "tool-settings.json"), JSON.stringify({ web_fetch: { permission: "ask" } }));
  const gate = new RunGate({ ...dirs, runId: "r1", harness: "claude-agent" });
  await gate.load({ harness }, ctx);
  const resumed = [];
  const park = { commit: (change) => harness.commit(change, ctx), parked: () => undefined };
  const start = () => gate.start(async (id, content, mark) => {
    resumed.push({ id, content });
    await harness.commit(mark, ctx);
  });
  return { gate, harness, storage, where: dirs, resumed, park, start };
}

async function requested(harness) {
  const root = await harness.conversation(ROOT_CONVERSATION_ID, ctx);
  const page = await root.entries({ order: "ascending" }, 100, undefined, ctx);
  return page.items.find((entry) => entry.kind === APPROVAL_ENTRY && entry.data?.phase === "requested")?.data;
}

/** The owner's deny (or a declining message's, `by: "message"`), as the server keeps it in the run's serve.json. */
const deny = (where, id, note, by) => writeFile(join(where.root, "serve.json"), JSON.stringify({ approvals: { [id]: { decision: "deny", ...(note ? { note } : {}), ...(by ? { by } : {}), answered_at: new Date().toISOString(), args_shown: JSON.stringify(ARGS) } } }));

const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (check()) return;
  throw new Error("timed out");
};

test("a replayed call parks with that kept in the store, and the owner's Deny says whether it took effect is not known", async (t) => {
  const run = await runOn(t);
  const parked = await run.gate.enter("web_fetch", ARGS, "c1", run.park, { replayed: true });
  assert.equal(parked?.parked, true, "it parks under ask");
  const request = await requested(run.harness);
  assert.equal(request?.replayed, true, "the store keeps that the request is a replay");
  await deny(run.where, request.id, "not this one");
  await run.start();
  await until(() => run.resumed.length === 1);
  assert.match(run.resumed[0].content, new RegExp(`The user denied this web_fetch call\\. ${UNKNOWN.replace(/[.]/g, "\\.")} Reason: not this one`));
  assert.ok(!run.resumed[0].content.includes(NOT_RUN), "never 'nothing was charged' on a replay");
});

test("after a restart between the park and the Deny, the reopened gate still refuses a replayed call with the unknown-outcome words", async (t) => {
  const first = await runOn(t);
  await first.gate.enter("web_fetch", ARGS, "c1", first.park, { replayed: true });
  const { id } = await requested(first.harness);
  const next = await runOn(t, { storage: first.storage, where: first.where });
  await deny(next.where, id);
  await next.start();
  await until(() => next.resumed.length === 1);
  assert.ok(next.resumed[0].content.includes(UNKNOWN) && !next.resumed[0].content.includes(NOT_RUN), next.resumed[0].content);
});

test("a declining message on a replayed call says the same, with the person's words", async (t) => {
  const run = await runOn(t);
  await run.gate.enter("web_fetch", ARGS, "c1", run.park, { replayed: true });
  const { id } = await requested(run.harness);
  await deny(run.where, id, "use the cached copy", "message");
  await run.start();
  await until(() => run.resumed.length === 1);
  assert.ok(run.resumed[0].content.includes(`${UNKNOWN} Reason: use the cached copy`) && !run.resumed[0].content.includes(NOT_RUN), run.resumed[0].content);
});

test("a first attempt that parks and is denied keeps the plain words: nothing was sent and nothing was charged", async (t) => {
  const run = await runOn(t);
  await run.gate.enter("web_fetch", ARGS, "c1", run.park);
  const request = await requested(run.harness);
  assert.equal(request?.replayed, undefined, "a first attempt is no replay");
  await deny(run.where, request.id);
  await run.start();
  await until(() => run.resumed.length === 1);
  assert.ok(run.resumed[0].content.includes(NOT_RUN), run.resumed[0].content);
});
