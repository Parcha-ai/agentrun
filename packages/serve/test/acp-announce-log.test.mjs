// serve's one debug switch for the ACP adapter: AGENTRUN_LOG=debug, read where serve builds an ACP agent's adapter
// (harness-table.ts), writes the adapter's "acp: the agent announced a call" line into the run's log; unset or quiet,
// never. Driven through a plan-billed ACP entry (acpEntryOf) on the fake ACP agent, whose recipe declares announces.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { withEnv } from "./support.mjs";

const { acpEntryOf } = await import("../dist/harness-table.js");
const { cursorFacts } = await import("@parcha/agentrun-harness-acp");
const { fakeAgentRecipe } = await import("@parcha/agentrun-harness-acp/testing");
const LINE = "acp: the agent announced a call";

/** One turn of the fake agent through the entry's adapter, built under AGENTRUN_LOG as `value` says (undefined: unset):
 *  the announce lines its log got. */
async function announced(t, value) {
  withEnv(t, value === undefined ? {} : { AGENTRUN_LOG: value }, ["AGENTRUN_LOG"]);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-acp-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  const facts = Object.freeze({ ...cursorFacts, id: "planner", label: "Planner" });
  const entry = acpEntryOf({ facts, recipe: () => fakeAgentRecipe("planner", dir, [{ call: "ping" }, { say: "done" }]) }, { log: (message, fields) => lines.push({ message, ...fields }) });
  const adapter = await entry.adapter({ ...process.env }, { model: { provider: "planner", modelId: "default" }, models: { getModel: () => undefined } });
  const home = join(dir, "session");
  mkdirSync(home);
  const store = memorySessionStore();
  const io = {
    writer: await store.open("s1"),
    models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} },
    signal: new AbortController().signal,
    onEvent: () => {},
    dir: home,
  };
  const ping = { name: "ping", description: "The test's ping tool.", inputSchema: { type: "object", properties: {} }, replay: "never", call: async () => ({ text: "pong" }) };
  const session = await adapter.open({ key: "s1", label: "root", system: [], tools: [ping], context: "fresh" }, io);
  t.after(() => session.close());
  await session.send("go");
  assert.equal((await session.turnEnd()).status, "completed");
  return lines.filter((line) => line.message === LINE);
}

test("AGENTRUN_LOG=debug writes the ACP adapter's line for each call the agent announces: its toolCallId, kind and the word its recipe's field holds", async (t) => {
  assert.deepEqual(await announced(t, "debug"), [{ message: LINE, toolCallId: "call_0", kind: "other", field: "agentrun__ping", ours: "ping" }]);
});

test("AGENTRUN_LOG unset or quiet never writes the ACP adapter's announce line, on a recipe that declares announces", async (t) => {
  assert.deepEqual(await announced(t, undefined), []);
  assert.deepEqual(await announced(t, "quiet"), []);
});
