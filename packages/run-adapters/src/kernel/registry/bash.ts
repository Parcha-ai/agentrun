// bash bounded to the run's hands (moved from serve's coding-tools.ts boundedBash): a call with no timeout runs at the
// default, one asking for more than the hands' ceiling runs at the ceiling and says so, in a diagnostic when it ends
// and in its error when it times out. The run itself is the host's (pi's bash over the run's hands).
import type { Executor } from "./hands.js";
import { BASH_DEFAULT_TIMEOUT_S } from "./limits.js";

const capWords = (asked: number, max: number, background: boolean) => `bash runs a command for at most ${max} s: this one ran with ${max} s, not the ${asked} s asked.${background ? " For longer work use bash_background." : ""}`;

/** `run`, bounded to its call's hands' `maxExecS`. */
export function boundedBash(run: Executor, background: boolean): Executor {
  return async (args, call) => {
    const max = call.hands.maxExecS;
    const asked = (args as { timeout?: unknown } | null)?.timeout;
    const capped = typeof asked === "number" && asked > max;
    const timeout = typeof asked === "number" ? Math.min(asked, max) : Math.min(BASH_DEFAULT_TIMEOUT_S, max);
    try {
      const answer = await run({ ...(args as object), timeout }, call);
      return capped ? { ...answer, diagnostics: [...(answer.diagnostics ?? []), { severity: "warn" as const, code: "timeout_capped", message: capWords(asked as number, max, background) }] } : answer;
    } catch (error) {
      if (capped && error instanceof Error && /timed out/i.test(error.message)) throw new Error(`${error.message}. ${capWords(asked as number, max, background)}`, { cause: error });
      throw error;
    }
  };
}
