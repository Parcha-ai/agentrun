// The faux harness (faux-harness.mjs's script) in a run's process that a test kills after a request was admitted (the
// runner's record of it written, its request_start emitted) and before its start mark reached the run's root. Once the
// file START_MARK_ARM names exists, the process stops at the next write of a start mark (agentrun.request_started),
// inside that write's transaction: it notes its pid in the file START_MARK_HELD names, then holds (60 s at most) for the
// test's SIGKILL. Once START_MARK_HELD exists nothing holds, so the process opened next writes as it would. serve imports
// this module in the run's open (adapters.ts adapterFor).
import { existsSync, writeFileSync } from "node:fs";
import { StatementSync } from "node:sqlite";

const [arm, held] = [process.env.START_MARK_ARM, process.env.START_MARK_HELD];
// Only a run's process: the server never writes a start mark.
if (arm && held && process.argv.includes("--app")) {
  const run = StatementSync.prototype.run;
  StatementSync.prototype.run = function (...params) {
    const record = params.at(-1);
    if (typeof record === "string" && record.startsWith("{") && existsSync(arm) && !existsSync(held)) {
      let entry;
      try { entry = JSON.parse(record); } catch { entry = undefined; }
      if (entry?.kind === "agentrun.request_started") {
        writeFileSync(held, JSON.stringify({ pid: process.pid, request: entry.data?.request ?? null }));
        const nap = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 3_000; i++) Atomics.wait(nap, 0, 0, 20);
      }
    }
    return run.apply(this, params);
  };
}

import { existsSync as exists } from "node:fs";
import { script as base } from "./faux-harness.mjs";

/** faux-harness.mjs's script, and one more: the first turn answers ($0.002) and ends ($0.001); the next turn's one request
 *  is admitted and never answered, until the file exists (then that turn has nothing more to ask, and ends). */
export function script(spec) {
  const cut = /Answer, then cut the next turn until (\S+)\./.exec(spec.system.join("\n"))?.[1];
  if (!cut) return base(spec);
  return [{ say: "Answer 1.", usd: 0.002 }, { end: true, usd: 0.001 }, ...(exists(cut) ? [] : [{ cut: true }])];
}
