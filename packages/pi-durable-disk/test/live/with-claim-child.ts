// One carry back for with-claim.live.test.ts, in a process of its own (another host, in effect):
//   node with-claim-child.ts <disk> <region> <path> <mountRoot> <label> <commit|hold> [holdMs]
// `commit` holds the path, adds one row to agent.sqlite, checkpoints with TRUNCATE and closes, then lets go. `hold` holds
// the path and writes nothing, until it is killed. The API key comes from the environment (ARCHIL_API_KEY); it reaches
// no child process: the mount token travels on the archil wrapper's stdin.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { archilControl } from "../../src/supervise.ts";
import { withClaim } from "../../src/with-claim.ts";

const [disk, region, path, mountRoot, label, mode, holdMs] = process.argv.slice(2);
const control = await archilControl({ apiKey: process.env.ARCHIL_API_KEY!, disk: disk!, region: region! });
const done = await withClaim(
  { control, disk: disk!, region: region!, path: path! },
  async (held) => {
    process.stdout.write(`held ${held.root}\n`); // the suite's ledger records the mountpoint
    if (mode === "hold") await new Promise(() => setInterval(() => {}, 1 << 30)); // a live timer keeps the process up until it is killed
    const db = new DatabaseSync(join(held.root, "agent.sqlite"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS carried (label TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO carried (label) VALUES (?)").run(label!);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    return label;
  },
  { mountRoot: mountRoot!, waitMs: 120_000, ...(holdMs ? { holdMs: Number(holdMs) } : {}) },
);
process.stdout.write(`committed ${done}\n`);
