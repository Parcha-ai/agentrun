// A host's code-mode tool as a pi-durable host writes one: the model's script runs in pi-codemode's sandbox with
// vision's global for this call (the one line a host adds), and the tool returns, as JSON text, what the script returned
// or its error. Replay-safe by default, so a call cut by a crash runs the script again; with `replay: "unsafe"`, pi's
// default and a code-mode host's, a cut call is never run again and the lead asks anew. Helpers, not tests.
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { callContext } from "@parcha/pi-vision/durable";
import { toolResult } from "./rig.mjs";

export const codeTool = (vision, { replay = "safe" } = {}) => ({
  name: "code-mode",
  tools: [{
    name: "code",
    description: "Run a script",
    replay,
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
