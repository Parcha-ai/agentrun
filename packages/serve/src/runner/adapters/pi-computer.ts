// pi's code mode on a run with a desktop or a phone: pi-durable's `codemode` tool beside the run's own tools (code mode
// "on", never "only": the model keeps every tool, and writes a script when one call does what many would), with
// `computer` bound in its scripts as computer_script binds it. The script's `tools.<name>(...)` are the conversation's
// tools, each a nested call through the session's gate; `computer` is the surface's script prelude over one host global
// (`__computerCall`), on the run's port, held by a person's take-over as the tools' port is. The `codemode` call itself
// is held to the computer kind's setting (tool-gate.ts settingsKeyOf), so a deny on desktop refuses the script whole.
//
// A script survives a restart by pi-durable's replay: the VM starts again from its stored start data and is handed the
// results it had, each global's outcome from its journal, so a computer call already answered is never made again.
// The sandbox runs each script in a worker of its own: an idle sandbox holds nothing.
import type { JsonValue } from "@earendil-works/chord";
import { CodemodeSandbox, type CodemodeExecuteOptions, type CodemodeRun, type CodemodeRunOptions, type CodemodeResult, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import type { Extension } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { COMPUTER_CALL_GLOBAL, scriptPrelude } from "@parcha/agentrun-computer/surface";
import { SCRIPT_MAX_MS, type ScriptComputer } from "../../workspace/index.js";

/** The code mode tool's name, as the model calls it and the gate reads it. */
export const PI_CODEMODE_TOOL = CODEMODE_TOOL_NAME;
const MEMORY_BYTES = 256 * 1024 * 1024;

/** A sandbox whose every script starts with `prelude`: one line, so the script's own line numbers hold. A rerun after a
 *  restart starts from the same code, so its replay is the first run's. */
class PreludedSandbox extends CodemodeSandbox {
  readonly #prelude: string;
  constructor(prelude: string, options: CodemodeSandboxOptions) {
    super(options);
    this.#prelude = prelude;
  }
  override execute(code: string, options?: CodemodeExecuteOptions): Promise<CodemodeResult> {
    return super.execute(`${this.#prelude}\n${code}`, options);
  }
  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    return super.start(`${this.#prelude}\n${code}`, options);
  }
}

/** pi's code mode extension with `computer` bound to `computer`'s surface: install it among the run's pi-native
 *  extensions (PiAdapterOptions.extensions). No `models.*` in scripts: a script's paid work is the run's own tools. */
export function computerCodemode(computer: ScriptComputer): Extension {
  const sandbox = new PreludedSandbox(scriptPrelude(computer.card), { timeoutMs: SCRIPT_MAX_MS, memoryLimitBytes: MEMORY_BYTES });
  return createCodemodeExtension({
    sandbox,
    models: false,
    // No tool listed again in the system prompt's codemode section: every tool is offered as itself (code mode "on"),
    // computer_script's description declares `computer` once, and a script finds any other with searchTools().
    inlineBudget: 0,
    globals: [{
      name: COMPUTER_CALL_GLOBAL,
      spread: true,
      // The value whole, images and all: a script shows one with image(...).
      execute: async (given, _api, context) => {
        const [op, args] = given as [unknown, unknown];
        return (await computer.guard.call(String(op), args, (sent) => computer.port.call(String(op), sent ?? {}, context.abortSignal))) as JsonValue;
      },
    }],
  });
}
