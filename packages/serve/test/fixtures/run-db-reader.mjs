// A reader of a run's database for run-db-checkpoint.test.mjs: reads `SELECT count(*) FROM t` over and over, for
// `ms`, the way the server's lock-free readers open it (`how`: `run-db`, run-db.ts openRunReader, as readStore,
// tookMessage, cap.ts, import-summary and import.ts do; `durable`, agentrun-pi's withDurableFile with `unlocked`, as
// durableDecisions does), and prints `{reads, errors, behind, last}`: a read that failed, and one that saw fewer rows
// than a read before it.
import { openRunReader } from "../../dist/run-db.js";
import { withDurableFile } from "../../../pi/dist/durable/readers.js";

const [file, how, ms] = process.argv.slice(2);
const count = how === "durable"
  ? () => withDurableFile(file, (db) => Number(db.prepare("SELECT count(*) AS n FROM t").get().n), { unlocked: true })
  : () => {
      const db = openRunReader(file);
      try {
        return Number(db.prepare("SELECT count(*) AS n FROM t").get().n);
      } finally {
        db.close();
      }
    };
const out = { reads: 0, errors: 0, behind: 0, last: 0, first: undefined };
for (const end = Date.now() + Number(ms); Date.now() < end; ) {
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
