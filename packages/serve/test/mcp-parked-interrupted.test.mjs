// A CLI's parked MCP call that was approved and then cut by a fault after it ran (its record holds a start, its sent
// mark, and the end "interrupted" the next open writes, with no output) is answered, when the CLI issues it again on
// resume, in the kernel's words for a call whose outcome is not known (INTERRUPTED_TEXT: it may or may not have taken
// effect), never as if it plainly ended, and it is never run again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERRUPTED_TEXT } from "@parcha/agentrun-kernel/kernel";
import { sendCommand } from "../dist/runner/commands.js";
import { parkedMcpRun } from "./fixtures/parking-cli.mjs";

test("an approved parked MCP call a fault cut is answered in the words of an outcome not known, and never run again", async (t) => {
  let faults = 0;
  const hooks = { beforeIntent: async () => {}, beforeResult: async () => { if (faults++ === 0) throw new Error("a fault after the call ran"); } };
  const { ran, said } = await parkedMcpRun(t, {
    gate: () => "ask",
    hooks,
    meanwhile: (server) => sendCommand(server, "run-1", { kind: "approve", body: { approval: "call-1" } }),
  });
  assert.deepEqual(ran, [{ path: "notes.md" }], "run once, never again");
  assert.deepEqual(said, [{ text: INTERRUPTED_TEXT, isError: true }], "the kernel's words for an outcome not known");
  assert.ok(!said[0].text.includes("call ended interrupted."), said[0].text);
});
