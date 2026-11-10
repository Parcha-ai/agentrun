// A reader of a run's database for run-db-checkpoint.test.mjs: reads `SELECT count(*) FROM t` over and over, for
// `ms`, the way the server's lock-free readers open it (`how`: `run-db`, run-db.ts readRunDbSync, as readStore,
// tookMessage, cap.ts, import-summary and import.ts do; `durable`, workflow/readers.ts's withDurableFile with `unlocked`, as
// durableDecisions does), and prints `{reads, errors, behind, last}`: a read that failed, and one that saw fewer rows
// than a read before it.
import { readRunDbSync } from "../../dist/run-db.js";
import { withDurableFile } from "../../dist/workflow/readers.js";

const [file, how, ms] = process.argv.slice(2);
const count = how === "durable"
  ? () => withDurableFile(file, (db) => Number(db.prepare("SELECT count(*) AS n FROM t").get().n), { unlocked: true })
  : () => readRunDbSync(file, false, (db) => Number(db.prepare("SELECT count(*) AS n FROM t").get().n));
const out = { reads: 0, errors: 0, behind: 0, last: 0, first: undefined };
// A short pause between reads: many reads during each checkpoint, without taking a CPU from the tests beside it.
const pause = new Int32Array(new SharedArrayBuffer(4));
for (const end = Date.now() + Number(ms); Date.now() < end; Atomics.wait(pause, 0, 0, 2)) {
  try {
    const n = count() ?? 0;
    out.reads++;
    if (n < out.last) out.behind++;
    out.last = Math.max(out.last, n);
  } catch (error) {
    out.errors++;
    out.first ??= String(error.message);
  }
}
process.stdout.write(JSON.stringify(out));
