// A writer for the box-loss tests (barriers-crash.test.ts): opens a run's store at the level given and runs a script of
// commits and barriers, printing each commit once it resolved; then SIGKILLs itself, holding the store open.
//   writer.ts <file> <FULL|NORMAL> <script>   script: a comma list of "c" (one commit) and "b" (syncNow)
import { BARRIER, syncNow } from "../../../src/barriers.ts";
import { openArchilStore } from "../../../src/store.ts";

const [file, level, script] = process.argv.slice(2) as [string, "FULL" | "NORMAL", string];
const store = await openArchilStore(file, "exclusive", { synchronous: level });
await store.database.exec("CREATE TABLE IF NOT EXISTS t (n INTEGER PRIMARY KEY)");
let n = 0;
for (const step of script.split(",")) {
  if (step === "c") {
    n++;
    await store.database.transaction((tx) => tx.run("INSERT INTO t (n) VALUES (?)", n));
    process.stdout.write(`commit ${n}\n`);
  } else if (step === "b") {
    await syncNow(store, BARRIER.runStatus);
    process.stdout.write(`barrier after ${n}\n`);
  }
}
process.stdout.write("done\n", () => process.kill(process.pid, "SIGKILL"));
