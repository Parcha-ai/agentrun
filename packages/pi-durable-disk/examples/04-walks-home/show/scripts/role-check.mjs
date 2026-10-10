// The stage's hello role against the REAL 03 server (take-server.mjs --cloud remote-local, no cloud machines): a stage that connects as `view` is refused its
// switch and its question with the pipe's own reasons, and one that connects as `operator` (the default) is not refused for its role.
//   node scripts/role-check.mjs
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, sleep, waitForStage } from "./cdp.mjs";
import { startTakeServer } from "./takeserver.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(homedir(), "tmp-d5", `role-${Date.now().toString(36)}`);
mkdirSync(root, { recursive: true, mode: 0o755 });
const kids = [];
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const start = (file, args, env) => {
  const k = spawn(process.execPath, [file, ...args], { cwd: show, env: { ...process.env, ...env }, stdio: "ignore" });
  kids.push(k);
  return k;
};
const post = (port, cmd) => fetch(`http://127.0.0.1:${port}/api/command`, { method: "POST", body: JSON.stringify(cmd) }).then(async (r) => {
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : { empty: true } };
});
const until = async (fn, ms) => {
  for (let t = 0; t < ms; t += 200) if (await fn()) return true; else await sleep(200);
  return false;
};
try {
  mkdirSync(join(root, "disk"), { recursive: true, mode: 0o755 });
  const take = await startTakeServer({ dir: join(root, "take"), disk: join(root, "disk") });
  kids.push(take.child);
  const link = take.status.linkFile;
  const ports = { view: await freePort(), operator: await freePort() };
  for (const [role, port] of Object.entries(ports)) {
    const child = start(join(show, "serve.ts"), [], { SHOW_PORT: String(port), SHOW_PIPE_LINK_FILE: link, SHOW_PIPE_ROLE: role, SHOW_ASK_AFTER_SWITCH: "0" });
    await waitForStage(port, child);
    // The pipe's environments arrive a moment after the stage is up.
    await until(async () => (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).environments.length > 0, 20_000);
  }
  const sw = await post(ports.view, { t: "switch", to: "remote-local" });
  expect("a view stage's switch is refused with the pipe's reason", sw.status === 409 && /only watches the run/.test(sw.body.message ?? ""), sw);
  // The run is parked (no tab attached), so an ask has no host; the refusal that matters is the role's, which comes first only when settled.
  const operator = await post(ports.operator, { t: "switch", to: "remote-local" });
  expect("an operator stage's switch is not refused for its role", !/only watches/.test(operator.body.message ?? ""), operator);
  const state = await (await fetch(`http://127.0.0.1:${ports.operator}/api/state`)).json();
  expect("the stage lists the host's environments either way", state.environments.some((e) => e.id === "remote-local") && state.source === "live", state.environments);
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failed++;
} finally {
  for (const k of kids) k.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
