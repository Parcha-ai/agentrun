// A host's code-mode tool as a pi-durable host writes one: the model's script runs in pi-codemode's sandbox with
// vision's global for this call (the one line a host adds), and the tool returns, as JSON text, what the script returned
// or its error. Replay-safe: a call cut by a crash runs the script again with the call's memos. Helpers, not tests.
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { callContext } from "@parcha/pi-vision/durable";
import { toolResult } from "./rig.mjs";

export const codeTool = (vision) => ({
  name: "code-mode",
  tools: [{
    name: "code",
    description: "Run a script",
    replay: "safe",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    execute: async ({ code }, api, context) => {
      const sandbox = new CodemodeSandbox({ globals: [vision.see(api.env, await callContext(api, context))] });
      try {
        const run = await sandbox.execute(code, { signal: context.abortSignal });
        return toolResult([{ type: "text", text: JSON.stringify(run.ok ? { ok: true, value: run.value } : { ok: false, error: run.error.message }) }]);
      } finally { await sandbox.close(); }
    },
  }],
});
