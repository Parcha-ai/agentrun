// Stands in for `pi-durable-archil run` in child-mode driver tests: reads the token from stdin, records what it was
// given, starts a detached long-running command the way pi does (its own process group), and exits 0 on SIGTERM.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

let token = "";
for await (const chunk of process.stdin) token += chunk;
const grandchild = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
grandchild.unref();
writeFileSync(
  process.env.PDA_TEST_OUT,
  JSON.stringify({ argv: process.argv.slice(2), token: token.trim(), envKeys: Object.keys(process.env), holder: process.env.PDA_HOLDER, pid: process.pid, grandchild: grandchild.pid }),
);
const keep = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  clearInterval(keep);
  process.exit(0);
});
