// Preloaded into a server process (node --import) by recovery.test: at the learningTestHooks seam
// AGENTRUN_TEST_HOLD_SEED names, a learning run's seed copy writes the run's directory to AGENTRUN_TEST_HOLD_SIGNAL and
// then holds, until the process is killed.
import { writeFileSync } from "node:fs";
import { learningTestHooks } from "../../dist/learning.js";

const seam = process.env.AGENTRUN_TEST_HOLD_SEED;
const signal = process.env.AGENTRUN_TEST_HOLD_SIGNAL;
if (seam && signal) {
  learningTestHooks[seam] = (runDir) => {
    writeFileSync(signal, runDir);
    return new Promise(() => {});
  };
}
