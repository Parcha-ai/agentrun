// Stands in for `pi-durable-archil run` under the Daytona launcher: reads stdin to its end, appends one line per
// incarnation to PDA_TEST_OUT (argv, token, holder, environment names, pid), then exits with the code PDA_TEST_CODES
// names for this incarnation (comma-separated, the last one repeats; "hold" runs until SIGTERM and exits 0).
import { appendFileSync, readFileSync } from "node:fs";

const out = process.env.PDA_TEST_OUT;
let token = "";
for await (const chunk of process.stdin) token += chunk;
let n = 0;
try {
  n = readFileSync(out, "utf8").split("\n").filter(Boolean).length;
} catch {}
appendFileSync(out, `${JSON.stringify({ n, argv: process.argv.slice(2), token: token.trim(), holder: process.env.PDA_HOLDER, envKeys: Object.keys(process.env), pid: process.pid })}\n`);
const codes = (process.env.PDA_TEST_CODES ?? "hold").split(",");
const code = codes[Math.min(n, codes.length - 1)];
if (code === "hold") {
  const keep = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(keep);
    process.exit(0);
  });
} else {
  process.exit(Number(code));
}
