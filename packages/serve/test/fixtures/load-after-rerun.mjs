// Preloaded into a run's process (NODE_OPTIONS=--import) by tool-gate-replayed-relaunch.test: the gate's open hook
// (RunGate.load, run by the app's onOpen) waits until a call has entered the gate. A reopened run's recovered call runs
// once its harness resumes, while onOpen runs: whichever comes first is a race. This hook makes the call win it, as it can
// in production, so a test reads what the gate knew when the rerun reached it. It writes AGENTRUN_TEST_LOAD_AFTER_ENTER
// once load has waited, so the test knows the hook ran.
import { writeFileSync } from "node:fs";
import { RunGate } from "../../dist/tool-gate.js";

const signal = process.env.AGENTRUN_TEST_LOAD_AFTER_ENTER;
if (signal) {
  let entered;
  const first = new Promise((resolve) => (entered = resolve));
  const { enter, load } = RunGate.prototype;
  RunGate.prototype.enter = function (...args) {
    entered();
    return enter.apply(this, args);
  };
  RunGate.prototype.load = async function (...args) {
    await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 20_000))]);
    writeFileSync(signal, "");
    return load.apply(this, args);
  };
}
