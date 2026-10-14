// A stand-in for a test process that starts a launcher and is then killed: it writes a launch spec, starts the launcher (which keeps its instance in a session of its own), says so, and waits to be killed.
//   node daytona-driver.ts <box dir>
// It ends once its stdin (a pipe from the test that started it) is closed, which the death of that test does, also while start() is
// still pending; the instance watches this process's pid, so the instance and the launcher end with it. A deadline bounds it whatever happens.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../src/hosts/daytona-launch.ts";

const CAP_MS = 120_000;
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
setTimeout(() => process.exit(0), CAP_MS);

const box = process.argv[2]!;
const INSTANCE = join(dirname(fileURLToPath(import.meta.url)), "daytona-instance.mjs");
mkdirSync(box, { recursive: true, mode: 0o700 });
writeFileSync(join(box, "x.json"), JSON.stringify({ argv: [process.execPath, INSTANCE], env: { PDA_TEST_OUT: join(box, "..", "out.jsonl"), PDA_TEST_CODES: "hold", PDA_TEST_PARENT: String(process.pid) } }));
writeFileSync(join(box, "x.token"), "tok");
const state = await start(box, "x", 20_000);
console.log(JSON.stringify({ started: state?.spawned ?? 0 }));
