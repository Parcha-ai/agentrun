---
packages: repo
kind: docs
---
**The disk showcase demo: a run outlives its box**
- `examples/disk` (`npm run demo:disk`) is the disk demo on the showcase template: an agent settles ten invoices through a paid tool, the process is killed after the
  fifth charge is paid and its answer kept, and the next one finishes the batch with every charge made once. The job is data (`job.ts`), the fakes are `fakes.ts`, and
  `run.ts` is the reference entry's `demo()`. `examples/disk.test.mjs` runs the three beats on fakes: the job, the kill and resume (counters repeated 0, unknown 0), and the
  receipts with cost. `live.ts` is the same demo with a real Daytona sandbox deleted mid-job on a real Archil disk, behind your own keys.
