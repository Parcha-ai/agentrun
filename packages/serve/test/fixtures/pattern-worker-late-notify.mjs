// A stand-in for pattern-worker.js (template-eval.test.mjs copies it beside a copy of dist/pattern-bound.js under that
// name) that forces the one interleaving a kept worker can't be relied on to show: the notify of one job arriving after
// the caller has started the next. From the second job on, the worker first wakes the caller waiting on that job (it
// notifies until a notify wakes someone), and only then, 300 ms later, answers it. A caller that takes any wake-up for
// its answer reads a reply that isn't there yet. It speaks both signals: the job's id when the job has one, else 1.
import { parentPort, workerData } from "node:worker_threads";

const { signal, port } = workerData;
const flag = new Int32Array(signal);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let answered = 0;

parentPort.on("message", (job) => {
  if (answered > 0) {
    // The job before's notify, late: it wakes the caller now waiting on this job (within 10 s of trying).
    for (let tries = 0; tries < 10_000 && Atomics.notify(flag, 0) === 0; tries++) pause(1);
    pause(300);
  }
  answered++;
  const reply = { matched: new RegExp(`^(?:${job.source})$`).test(job.text) };
  port.postMessage(job.id === undefined ? reply : { id: job.id, ...reply });
  Atomics.store(flag, 0, job.id ?? 1);
  Atomics.notify(flag, 0);
});
