// The faux harness (faux-harness.mjs's script) in a run's process that a test kills between a turn's last writes and the
// write of its end. Once the file TURN_END_ARM names exists, the process stops at the first write of a turn's end
// (adapter.turn_end) still to come, inside that write's transaction: it notes its pid and the kinds of the entries written
// since the arm in the file TURN_END_HELD names, then holds (60 s at most) for the test's SIGKILL. The session then has the
// turn over and the root has the turn's last entry, with no end. Once TURN_END_HELD exists nothing holds, so the process
// opened next writes as it would.
import { existsSync, writeFileSync } from "node:fs";
import { StatementSync } from "node:sqlite";

const [arm, held] = [process.env.TURN_END_ARM, process.env.TURN_END_HELD];
// Only a run's process: the server never runs a turn.
if (arm && held && process.argv.includes("--app")) {
  const run = StatementSync.prototype.run;
  const since = [];
  StatementSync.prototype.run = function (...params) {
    const record = params.at(-1);
    if (typeof record === "string" && record.startsWith("{") && existsSync(arm) && !existsSync(held)) {
      let kind;
      try { kind = JSON.parse(record).kind; } catch { kind = undefined; }
      if (kind === "adapter.turn_end") {
        writeFileSync(held, JSON.stringify({ pid: process.pid, since }));
        const nap = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 3_000; i++) Atomics.wait(nap, 0, 0, 20);
      } else if (typeof kind === "string") since.push(kind);
    }
    return run.apply(this, params);
  };
}

export { script } from "./faux-harness.mjs";
