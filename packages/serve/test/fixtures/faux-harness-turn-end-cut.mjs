// The faux harness (faux-harness.mjs's script) in a run's process that a test kills between a turn's last writes and the
// write of its end. Once the file TURN_END_ARM names exists, the process stops at the first write of a turn's end
// (adapter.turn_end) still to come, inside that write's transaction: it notes its pid and the kinds of the entries written
// since the arm in the file TURN_END_HELD names, then holds (60 s at most) for the test's SIGKILL. The session then has the
// turn over and the root has the turn's last entry, with no end. Once TURN_END_HELD exists nothing holds, so the process
// opened next writes as it would. The arm file may hold a number: that many turn ends pass first, then the next is held.
// "<n> after": n turn ends pass, then the first record of any kind written after the n-th (in a commit of its own, after
// that turn end's) is held instead; TURN_END_HELD then also names that record's kind (`at`).
// TURN_END_AGAIN, once TURN_END_HELD exists: the process opened next holds once more, the same way (the arm's count and
// mode, counted in that process), and notes in the file TURN_END_AGAIN names instead; once that exists nothing holds.
// TURN_END_GATE, once TURN_END_HELD exists: the process opened next waits in its open, before it writes anything of the
// reopen's, until it has answered an event stream (the server's, its snapshot written with the door idle), then notes so
// in the file TURN_END_GATE names. serve imports this module in the run's open (adapters.ts adapterFor), after the door
// is attached, so the wait is the open's own and the server's stream can connect meanwhile.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ServerResponse } from "node:http";
import { StatementSync } from "node:sqlite";

const [arm, held, again] = [process.env.TURN_END_ARM, process.env.TURN_END_HELD, process.env.TURN_END_AGAIN];
// Only a run's process: the server never runs a turn.
if (arm && held && process.argv.includes("--app")) {
  const run = StatementSync.prototype.run;
  const since = [];
  const passed = new Set();
  StatementSync.prototype.run = function (...params) {
    const record = params.at(-1);
    // The file this hold notes in: TURN_END_HELD first, then TURN_END_AGAIN's, in a process opened after it.
    const into = !existsSync(held) ? held : again && !existsSync(again) ? again : undefined;
    if (typeof record === "string" && record.startsWith("{") && existsSync(arm) && into) {
      let kind;
      try { kind = JSON.parse(record).kind; } catch { kind = undefined; }
      const [count, mode] = readFileSync(arm, "utf8").trim().split(/\s+/);
      const pass = Number(count) || 0;
      const after = mode === "after";
      if (kind === "adapter.turn_end" && (passed.has(record) || passed.size < pass)) {
        passed.add(record);
        since.push(kind);
      } else if (after ? typeof kind === "string" && passed.size >= pass : kind === "adapter.turn_end") {
        writeFileSync(into, JSON.stringify({ pid: process.pid, since, at: kind }));
        const nap = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 3_000; i++) Atomics.wait(nap, 0, 0, 20);
      } else if (typeof kind === "string") since.push(kind);
    }
    return run.apply(this, params);
  };
}

const gate = process.env.TURN_END_GATE;
if (gate && held && process.argv.includes("--app") && existsSync(held)) {
  let streamed = false;
  const writeHead = ServerResponse.prototype.writeHead;
  ServerResponse.prototype.writeHead = function (...args) {
    const headers = args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
    if (String(headers?.["content-type"] ?? "").startsWith("text/event-stream")) streamed = true;
    return writeHead.apply(this, args);
  };
  // A ceiling only: a stream that never came is written down, and the test fails on it by name.
  for (const end = Date.now() + 60_000; !streamed && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(gate, JSON.stringify({ streamed }));
}

import { script as base } from "./faux-harness.mjs";

/** faux-harness.mjs's script, and one more: turn 1 holds on a fetch until the first file exists (faux-web-hold.mjs), so
 *  follow-ups wait their place, then answers; turn 2 (the first follow-up) answers nothing; turn 3 (the second) holds on
 *  a fetch until the second file exists, then answers. */
export function script(spec) {
  const queued = /Queue two follow-ups until (\S+), then hold the last until (\S+)\./.exec(spec.system.join("\n"));
  if (!queued) return base(spec);
  const hold = (until) => ({ call: "fetch_page", args: { url: `http://public.example/hold?until=${encodeURIComponent(until)}` }, usd: 0.001 });
  return [hold(queued[1]), { say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, { end: true, usd: 0.001 }, hold(queued[2]), { say: "Answer 3.", usd: 0.001 }, { end: true, usd: 0.001 }];
}
