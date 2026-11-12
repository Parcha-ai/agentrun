// computer_script's run: the model's JavaScript in a QuickJS isolate here in serve (pi-codemode's CodemodeSandbox, a
// worker thread per script), whose only binding is the claim's computer. The script sees `computer` (the surface's
// script prelude builds it inside the isolate over one host function, __computerCall) and pi-codemode's output helpers
// (text, image, console); no network, no keys, no timers, no modules, no file of this machine. Each call of the computer
// goes through the run's hands (Hands.computer), so a person's hold parks and refuses it as it does a per-step tool's.
//
// The answer: the script's text and images in the order it made them, then its returned value as JSON (its images'
// data left out: they are the answer's images); `structured` is the value. A script that threw answers its words, with
// what it showed before.
import { CodemodeSandbox, type CodemodeOutputItem } from "@earendil-works/pi-codemode";
import { type Card, COMPUTER_CALL_GLOBAL, scriptPrelude, withoutImageData } from "@parcha/agentrun-computer/surface";
import type { JsonValue, ToolImage } from "@parcha/agentrun-kernel";
import type { Executor, ToolAnswer } from "@parcha/agentrun-kernel/kernel";

/** A script's longest run by default, and at most, in ms. */
export const SCRIPT_DEFAULT_MS = 120_000;
export const SCRIPT_MAX_MS = 600_000;
/** The isolate's memory. */
const SCRIPT_MEMORY_BYTES = 256 * 1024 * 1024;

type ScriptArgs = { readonly code?: unknown; readonly timeoutMs?: unknown };

/** The script's own output and its value, as the model reads them. */
function answerOf(output: readonly CodemodeOutputItem[], value: unknown): { text: string; images: ToolImage[] } {
  const words: string[] = [];
  const images: ToolImage[] = [];
  for (const item of output) {
    if (item.type === "text") words.push(item.text);
    else images.push({ data: item.data, mimeType: item.mimeType });
  }
  if (value !== undefined) words.push(typeof value === "string" ? value : JSON.stringify(withoutImageData(value)));
  return { text: words.join("\n") || "(the script returned nothing and showed nothing)", images };
}

/** computer_script's executor for a computer that is `card`: each script in its own isolate, its computer calls through
 *  the call's hands. */
export function computerScriptExecutor(card: Card): Executor {
  const prelude = scriptPrelude(card);
  return async (args, call): Promise<ToolAnswer> => {
    const { code, timeoutMs } = (args ?? {}) as ScriptArgs;
    if (typeof code !== "string" || code.trim() === "") return { text: "", error: "computer_script needs code: the body of an async function, with `computer` bound" };
    const port = call.hands.computer;
    if (!port) return { text: "", error: "computer_script needs a desktop or a phone computer: this run has none" };
    const limit = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, SCRIPT_MAX_MS) : SCRIPT_DEFAULT_MS;
    const sandbox = new CodemodeSandbox({
      timeoutMs: limit,
      memoryLimitBytes: SCRIPT_MEMORY_BYTES,
      globals: [{
        name: COMPUTER_CALL_GLOBAL,
        spread: true,
        // The value whole, images and all: a script shows one with image(...). The JSON round trip is the isolate's.
        execute: async (given, context) => {
          const [op, opArgs] = given as [unknown, unknown];
          const answer = await port.call(String(op), opArgs ?? {}, AbortSignal.any([context.signal, ...(call.signal ? [call.signal] : [])]));
          return answer.value ?? null;
        },
      }],
    });
    try {
      // The prelude is one line, so the script's own line numbers hold.
      const result = await sandbox.execute(`${prelude}\n${code}`, call.signal ? { signal: call.signal } : {});
      if (!result.ok) {
        if (result.error.kind === "aborted" && call.signal?.aborted) throw call.signal.reason ?? new Error(result.error.message);
        const shown = answerOf(result.output, undefined);
        const why = result.error.kind === "timeout" ? `the script ran past its ${limit} ms: ${result.error.message}` : result.error.message;
        return { text: result.output.length > 0 ? shown.text : "", error: why, ...(shown.images.length > 0 ? { images: shown.images } : {}) };
      }
      const shown = answerOf(result.output, result.value);
      return { text: shown.text, ...(shown.images.length > 0 ? { images: shown.images } : {}), structured: (withoutImageData(result.value) ?? null) as JsonValue };
    } finally {
      await sandbox.close();
    }
  };
}
