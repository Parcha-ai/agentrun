// A parked MCP call (a CLI harness's, held at its tool bridge's gate as any host tool's is) whose gate answers
// asynchronously on the claim that resumes it: a deny set since the person's allow denies the call in its words and it
// never runs; a word that is no deny lets the allowed call run once. The gate is Promise-capable on purpose (run-cap's
// and the approvals' gates may look a decision up), so the resumed call awaits its answer: a deny that resolves to words
// denies the call, never a pending Promise taken as the answer (which would mislabel the result and could let it run).
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCommand } from "../dist/runner/commands.js";
import { CATALOG, parkedMcpRun } from "./fixtures/parking-cli.mjs";

const DENY = `Permission denied: ${CATALOG} is set to deny.`;
const later = (value) => new Promise((resolve) => setImmediate(() => resolve(value)));

/** A gate that asks about the call first, then answers `now` asynchronously on every ask after (the resumed call's). */
function gateThen(now) {
  let asked = 0;
  return async (call) => {
    assert.equal(call.tool, CATALOG, "the gate is asked by the MCP tool's catalog name");
    return asked++ === 0 ? "ask" : later(now);
  };
}

const allowed = (server) => sendCommand(server, "run-1", { kind: "approve", body: { approval: "call-1" } });

test("a parked MCP call whose gate denies asynchronously on resume gets the deny words and never runs", async (t) => {
  const { ran, said } = await parkedMcpRun(t, { gate: gateThen({ deny: DENY }), meanwhile: allowed });
  assert.deepEqual(ran, [], "a call the gate denies is never run");
  assert.deepEqual(said, [{ text: DENY, isError: true }], "the deny words are the call's answer, not a pending Promise");
});

test("a parked MCP call whose gate's asynchronous word on resume is no deny (still ask, the person allowed) runs once", async (t) => {
  const { ran, said } = await parkedMcpRun(t, { gate: gateThen("ask"), meanwhile: allowed });
  assert.deepEqual(ran, [{ path: "notes.md" }], "the allowed call runs exactly once");
  assert.deepEqual(said.map((result) => result.text), ["the call ran"]);
  assert.doesNotMatch(JSON.stringify(said), /\[object Promise\]/);
});
