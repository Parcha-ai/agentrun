// A call the gate asks about or refuses is named by the one name the spec's gate gives it (askedAs: its settings key,
// `mcp:fake/add` for the wire's `mcp__fake__add`), never by its wire name: the ask entry (the pending approval and its
// card) and the words a bare "deny" answers the model alike. Through the adapter loop's preIntentGate, on pi through the
// adapter, with a spec gate that answers the plain permission and names calls by askedAs.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { deniedText: setToDenyText } = await import("../dist/refusal-words.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

const WIRE = "mcp__fake__add";
const CATALOG = "mcp:fake/add";

/** One pi run whose model calls `mcp__fake__add`, its spec gate answering `permission` and naming the call by askedAs
 *  (`mcp:fake/add`). Runs until the run is not running: its row, every request the model was sent, and its journal. */
async function namedRun(t, permission) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const tools = { [WIRE]: { name: WIRE, replaySafe: false, ask: false, run: async () => "5" } };
  const script = [{ call: WIRE, args: { a: 2, b: 3 } }, { sayLastResult: true }];
  const sent = [];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, sent) });
  const gate = Object.assign(() => permission, { askedAs: (tool) => (tool === WIRE ? CATALOG : tool) });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await base(claim, run)), gate }));
  const runner = startRunner({ store: opened.runners[0], createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state !== "running" && now.state !== "queued" && now.runner === null && now;
  }, "the run settled", 30_000);
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  return { row, sent, entries };
}

/** The text of the newest tool result the model was sent. */
const lastResult = (sent) => {
  const results = sent.flatMap((body) => body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "tool_result");
  const content = results.at(-1)?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
};

test("an asked call's ask entry is named by the gate's askedAs name, never its wire name", async (t) => {
  const { row, entries } = await namedRun(t, "ask");
  assert.equal(row.state, "parked", JSON.stringify(row));
  const ask = entries.find((entry) => entry.kind === "agentrun.ask")?.data;
  assert.equal(ask?.tool, CATALOG, JSON.stringify(ask));
});

test("a call its tool's setting denies is refused in main's words by the gate's askedAs name, never its wire name", async (t) => {
  const { row, sent } = await namedRun(t, "deny");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(sent), setToDenyText(CATALOG));
  assert.ok(!lastResult(sent).includes(WIRE), lastResult(sent));
});
