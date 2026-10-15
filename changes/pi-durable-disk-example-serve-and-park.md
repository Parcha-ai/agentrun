---
packages: @parcha/pi-durable-disk
kind: docs
---
**An example, `serve-and-park`: an idle agent holds no process**
- An instance serves `POST /submit` on a directory of this machine. Its model is overloaded and pi retries after a long
  wait, so the run parks: `run.json` says `sleeping` with `wakeAt`, the claim is released and the process exits 0. A
  small restart loop opens the run again at `wakeAt`, the retry finishes, and a repeated `requestId` is answered with the
  first submission instead of running again. No disk, no key: `node examples/serve-and-park/main.ts` after the build,
  with pi-ai's faux model. A test runs it in `npm test`.
