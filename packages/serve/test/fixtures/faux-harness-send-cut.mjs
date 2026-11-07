// The faux harness (faux-harness.mjs's script) in a run's process that a test kills in the window between a turn's end
// and the record of the next message's send: once the file SEND_CUT_ARM names exists, the process stops at the first
// write of a session turn's start (faux.turn) still to come, inside that write's transaction. That is the send of the
// message that waited behind the turn: the turn before it has written its end, and the root has the message accepted but
// neither its entry nor its end. The process notes its pid in the file SEND_CUT_HELD names, then holds (60 s at most) for
// the test's SIGKILL. Once SEND_CUT_HELD exists nothing holds, so the process opened next writes as it would.
import { existsSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { writeWhole } from "./write-whole.mjs";

const [arm, held] = [process.env.SEND_CUT_ARM, process.env.SEND_CUT_HELD];
// Only a run's process: the server never runs a turn.
if (arm && held && process.argv.includes("--app")) {
  const run = StatementSync.prototype.run;
  StatementSync.prototype.run = function (...params) {
    const record = params.at(-1);
    if (typeof record === "string" && record.startsWith("{") && existsSync(arm) && !existsSync(held)) {
      let kind;
      try { kind = JSON.parse(record).kind; } catch { kind = undefined; }
      if (kind === "faux.turn") {
        writeWhole(held, JSON.stringify({ pid: process.pid }));
        const nap = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 3_000; i++) Atomics.wait(nap, 0, 0, 20);
      }
    }
    return run.apply(this, params);
  };
}

export { script } from "./faux-harness.mjs";
