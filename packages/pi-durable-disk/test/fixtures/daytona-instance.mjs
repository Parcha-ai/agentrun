// Stands in for `pi-durable-disk run` under the Daytona launcher: reads stdin to its end, appends one line per
// incarnation to PDA_TEST_OUT (argv, token, holder, environment names, the values of the names PDA_TEST_ECHO lists, pid),
// then exits with the code PDA_TEST_CODES names for this incarnation (comma-separated, the last one repeats; "hold" runs
// until SIGTERM and exits 0, after a drain that detaches a program when PDA_TEST_DRAIN_SPAWN is set).
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const out = process.env.PDA_TEST_OUT;
// A test run that is killed (a timeout, a forced exit, SIGKILL) never reaches its teardown, and this process leads a session of its own: nothing else would ever stop it, nor the launcher that
// keeps restarting it. So it watches the test process that started it (PDA_TEST_PARENT) and ends itself with a terminal exit (75: the launcher does not restart it, and ends too) once that is gone.
const parent = Number(process.env.PDA_TEST_PARENT);
if (parent > 0) {
  const watch = setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (error) {
      if (error.code === "ESRCH") process.exit(75);
    }
  }, 500);
  watch.unref();
}
let token = "";
for await (const chunk of process.stdin) token += chunk;
let n = 0;
try {
  n = readFileSync(out, "utf8").split("\n").filter(Boolean).length;
} catch {}
const echo = Object.fromEntries((process.env.PDA_TEST_ECHO ?? "").split(",").filter(Boolean).map((name) => [name, process.env[name] ?? null]));
appendFileSync(out, `${JSON.stringify({ n, argv: process.argv.slice(2), token: token.trim(), holder: process.env.PDA_HOLDER, envKeys: Object.keys(process.env), echo, pid: process.pid })}\n`);
const codes = (process.env.PDA_TEST_CODES ?? "hold").split(",");
const code = codes[Math.min(n, codes.length - 1)];
if (code === "hold") {
  const keep = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(keep);
    const spawnIn = process.env.PDA_TEST_DRAIN_SPAWN;
    if (!spawnIn) process.exit(0);
    // Draining: a tool the agent ran leaves a program detached in PDA_TEST_DRAIN_SPAWN (its pid goes to PDA_TEST_OUT as
    // `drainSpawned`), and the drain goes on for PDA_TEST_DRAIN_MS before the instance exits.
    const r = spawnSync("sh", ["-c", "setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $!"], { cwd: spawnIn, encoding: "utf8" });
    appendFileSync(out, `${JSON.stringify({ drainSpawned: Number(r.stdout.trim()) })}\n`);
    setTimeout(() => process.exit(0), Number(process.env.PDA_TEST_DRAIN_MS ?? 500));
  });
} else {
  process.exit(Number(code));
}
