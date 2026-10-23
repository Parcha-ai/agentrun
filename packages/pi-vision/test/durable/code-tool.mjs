// A host's code-mode tool as a pi-durable host writes one: the model's script runs in pi-codemode's sandbox with
// vision's globals for this call (the one line a host adds), and the tool returns, as JSON text, what the script returned
// or its error. Replay-safe by default, so a call cut by a crash runs the script again; with `replay: "unsafe"`, pi's
// default and a code-mode host's, a cut call is never run again and the lead asks anew. With `taskMemos`, the tool API
// the adapter gets has no `commit` or `snapshot`, so the call's memos are kept on its task. Helpers, not tests.
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { callContext } from "@parcha/pi-vision/durable";
import { toolResult } from "./rig.mjs";

const withoutStore = (api) => new Proxy(api, { get: (target, key) => {
  if (key === "commit" || key === "snapshot") return undefined;
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
} });

export const codeTool = (vision, { replay = "safe", taskMemos = false } = {}) => ({
  name: "code-mode",
  tools: [{
    name: "code",
    description: "Run a script",
    replay,
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    execute: async ({ code }, api, context) => {
      const call = await callContext(taskMemos ? withoutStore(api) : api, context);
      const sandbox = new CodemodeSandbox({ globals: [vision.see(api.env, call), vision.judge(api.env, call), vision.transcribe(api.env, call)] });
      try {
        const run = await sandbox.execute(code, { signal: context.abortSignal });
        return toolResult([{ type: "text", text: JSON.stringify(run.ok ? { ok: true, value: run.value } : { ok: false, error: run.error.message }) }]);
      } finally { await sandbox.close(); }
    },
  }],
});
