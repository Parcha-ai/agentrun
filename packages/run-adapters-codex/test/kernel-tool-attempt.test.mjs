// The kernel's step for a host tool's call is `tool:<call id>#<attempt>`: attempt 0 the first time, 1 or more when a
// crash cut an earlier attempt of a replay-safe tool and the next drive runs it again. The host hears the call id and
// the attempt, so its gate can tell a replay (whose first attempt may have been sent) from a first call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { kernelTool } from "../dist/adapter.js";

test("a host tool hears the call id and the kernel's attempt from the effect's step", async () => {
  const heard = [];
  const tool = { name: "web_fetch", description: "fetch", inputSchema: { type: "object" }, replay: "safe", call: async (_input, context) => (heard.push({ callId: context.callId, attempt: context.attempt }), { text: "ok" }) };
  const kernel = kernelTool(tool);
  const signal = new AbortController().signal;
  await kernel.execute({}, { signal, progress: () => undefined, ctx: {}, stepId: "tool:call_9#0" });
  await kernel.execute({}, { signal, progress: () => undefined, ctx: {}, stepId: "tool:call_9#1" });
  assert.deepEqual(heard, [{ callId: "call_9", attempt: 0 }, { callId: "call_9", attempt: 1 }]);
});
