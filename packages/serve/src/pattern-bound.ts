// A template eval's `{"$pattern": <regex>}` (a fake's `when`, a tool_used grader's `args`) tested against a value at most
// PATTERN_MS. The regex is the template's and the value is a run's, so a pattern that backtracks without end
// (`(a+)+b` on forty a's) would hold the grade, or the fake answering a call, for hours. It runs in one worker thread
// (pattern-worker.ts), kept for the next test; the caller waits on a shared signal (Atomics.wait), so a test stays
// synchronous, as the graders and the fakes that call it are. Past the limit the worker is terminated, the next test makes
// a new one, and the test throws PatternTimeout: never a match or a miss the engine did not finish. The worker never holds
// a process open: it is unref'd.
import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { PatternReply } from "./pattern-worker.js";

/** The longest one `$pattern` test runs before it is stopped. */
export const PATTERN_MS = 2_000;
/** The longest a new worker may take to start before the test it was made for runs: a loaded machine's start-up, which
 *  PATTERN_MS never counts. */
const START_MS = 30_000;

/** A `$pattern` test stopped at PATTERN_MS, or a worker that failed to start or answer. */
export class PatternTimeout extends Error {
  override readonly name = "PatternTimeout";
}

type Held = { worker: Worker; port: MessagePort; flag: Int32Array };
let held: Held | undefined;

function stop(): void {
  const gone = held;
  held = undefined;
  if (!gone) return;
  gone.port.close();
  void gone.worker.terminate();
}

function worker(): Held {
  if (held) return held;
  const signal = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  const made = new Worker(new URL("./pattern-worker.js", import.meta.url), { workerData: { signal, port: port2 }, transferList: [port2], execArgv: [] });
  made.unref();
  port1.unref();
  made.on("error", () => {
    if (held?.worker === made) stop();
  });
  held = { worker: made, port: port1, flag: new Int32Array(signal) };
  // A first test that tells nothing (the empty pattern on the empty value) waits out the start, under START_MS.
  ask(held, "", "", START_MS);
  return held;
}

function ask(on: Held, source: string, text: string, ms: number): boolean {
  Atomics.store(on.flag, 0, 0);
  on.worker.postMessage({ source, text });
  if (Atomics.wait(on.flag, 0, 0, ms) === "timed-out") {
    stop();
    throw new PatternTimeout(`did not finish within ${ms} ms`);
  }
  const reply = receiveMessageOnPort(on.port)?.message as PatternReply | undefined;
  if (!reply) {
    stop();
    throw new PatternTimeout("the pattern's worker gave no answer");
  }
  if ("failed" in reply) throw new PatternTimeout(`the pattern's worker failed (${reply.failed})`);
  return reply.matched;
}

/** Whether `text` is matched whole by the regex `source` (anchored, ^(?:source)$), decided within PATTERN_MS, else
 *  PatternTimeout. `source` compiles: the case's read refused one that doesn't. */
export function testPattern(source: string, text: string): boolean {
  return ask(worker(), source, text, PATTERN_MS);
}
