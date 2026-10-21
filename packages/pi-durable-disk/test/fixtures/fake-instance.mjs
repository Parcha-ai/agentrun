// Stands in for `pi-durable-disk run` in child-mode driver tests: reads the token from stdin, records what it was
// given, starts a detached long-running command the way pi does (its own process group), and exits 0 on SIGTERM.
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

let token = "";
for await (const chunk of process.stdin) token += chunk;
const grandchild = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
grandchild.unref();
// Written whole and renamed into place: a reader that sees the file sees all of it (one that polls for it never parses half).
const out = process.env.PDA_TEST_OUT;
writeFileSync(`${out}.${process.pid}.tmp`, JSON.stringify({ argv: process.argv.slice(2), token: token.trim(), envKeys: Object.keys(process.env), holder: process.env.PDA_HOLDER, pid: process.pid, grandchild: grandchild.pid }));
renameSync(`${out}.${process.pid}.tmp`, out);
const keep = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  clearInterval(keep);
  process.exit(0);
});
