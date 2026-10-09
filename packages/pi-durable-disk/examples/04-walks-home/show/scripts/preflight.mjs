// Live-day preflight: every way the stage has gone wrong in rehearsal, checked in one run, so a surprise is a line of output
// before the take and not a blank pane during it.
//   CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> POLICY_DIR=<dir> [SHOW_API=http://host:port] node scripts/preflight.mjs
//   A live take (SHOW_PIPE_LINK_FILE, the same file serve.ts follows) needs no POLICY_DIR: the policy comes from the run's disk.
//   SHOW_URL=<the running stage> checks what that stage serves the home beat instead of this script's own environment.
// Exits non-zero if any check fails. Reads and probes only: it starts nothing and spends nothing.
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.mjs";
import { checkHomePolicy, checkServedHomePolicy } from "../home-policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const tabDir = process.env.TAB_DIR;
const api = process.env.SHOW_API?.replace(/\/$/, "");
const showUrl = process.env.SHOW_URL?.replace(/\/$/, "");
const ex03 = join(here, "..", "..", "..", "03-tab-to-cloud");
let failed = 0;
const check = async (name, fn) => {
  try {
    const r = await fn();
    const [ok, note] = Array.isArray(r) ? r : [r === undefined ? true : !!r, ""];
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? `  (${note})` : ""}`);
    if (!ok) failed++;
  } catch (error) {
    console.log(`FAIL ${name}  (${error.message})`);
    failed++;
  }
};
/** The newest modification time under a directory, ignoring build output and dependencies. */
const newest = (dir) => {
  let t = 0;
  for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
    if (["node_modules", "dist", ".git"].includes(e.name)) continue;
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
};

await check("Node is 22.19 or newer", () => {
  const [a, b] = process.versions.node.split(".").map(Number);
  return [a > 22 || (a === 22 && b >= 19), process.versions.node];
});
await check("the recorder's ffmpeg is there", () => existsSync(process.env.FFMPEG ?? `${homedir()}/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux`));
await check("the stage page is built", () => existsSync(join(here, "..", "page", "dist", "main.js")) && statSync(join(here, "..", "page", "dist", "main.js")).mtimeMs >= newest(join(here, "..", "page")) - 1000 ? true : [false, "page/dist is older than page/ sources: node page/build.mjs"]);

await check("Chrome answers on the CDP port", async () => (await fetch(`${cdpUrl}/json/version`)).ok);
await check("that Chrome has WebGL (the creature's 3D view needs it)", async () => {
  const server = createServer((_, res) => res.end("<!doctype html><canvas id=c></canvas>"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const tab = await openTab(`http://127.0.0.1:${server.address().port}/`);
  try {
    await new Promise((r) => setTimeout(r, 800));
    const gl = await tab.eval(`!!document.getElementById("c").getContext("webgl2")`);
    return [gl, gl ? "" : "start one with scripts/chrome.mjs; the shared Chrome on 9222 has none"];
  } finally {
    await tab.close();
    server.close();
  }
});

await check("the tab app's build is there and newer than its sources", () => {
  if (!tabDir) return [false, "set TAB_DIR to the tab app's dist"];
  const dist = join(tabDir, "main.js");
  if (!existsSync(dist)) return [false, `no ${dist}`];
  const src = join(tabDir, "..", "src");
  return existsSync(src) && statSync(dist).mtimeMs < newest(src) - 1000 ? [false, "dist is older than src: node build.mjs in the tab app's folder"] : true;
});
// The home beat's policy as the tab will take it (or, in a live take, the run link it comes through): show/home-policy.ts. With
// SHOW_URL it is what the running stage serves, which is what the camera sees; without, what this script's environment names.
await check(
  showUrl ? `the home beat's policy, as the running stage serves it (${showUrl})` : "the home beat's policy: one the tab loads, or in a live take the run link",
  () => (showUrl ? checkServedHomePolicy(showUrl) : checkHomePolicy(process.env)),
);
if (!showUrl) console.log("note  no SHOW_URL: the running stage's own /policy/home.json is not probed; start the stage and pass its URL to check it");
await check("the 03 tab page is built and newer than its sources (an old one never times a switch back)", () => {
  const dist = join(ex03, "tab", "dist", "main.js");
  if (!existsSync(dist)) return [false, "node tab/build.mjs --fetch in 03-tab-to-cloud"];
  const src = Math.max(newest(join(ex03, "tab")), statSync(join(ex03, "wire.ts")).mtimeMs, statSync(join(ex03, "environment.ts")).mtimeMs);
  return statSync(dist).mtimeMs < src - 1000 ? [false, "tab/dist is older than its sources: rebuild it"] : true;
});
await check("the model broker answers (the agent's answers after a switch)", async () => (await fetch("http://127.0.0.1:9421/v1/models", { signal: AbortSignal.timeout(4000) })).ok);

// The take's own 03 server (scripts/take-server.mjs): up, and its admin token readable only by us. The token itself is never read.
const takeStatus = process.env.TAKE_STATUS;
if (takeStatus) {
  await check("the take's 03 server is up and its admin token file is private (mode 0600, in a 0700 directory)", async () => {
    const st = JSON.parse(readFileSync(takeStatus, "utf8"));
    try {
      process.kill(st.pid, 0);
    } catch {
      return [false, `pid ${st.pid} is not running`];
    }
    const up = await fetch(st.origin, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
    const file = statSync(st.tokenFile);
    const dir = statSync(dirname(st.tokenFile));
    const ok = up && (file.mode & 0o777) === 0o600 && (dir.mode & 0o777) === 0o700 && file.size > 0;
    return [ok, `${st.origin}, ${st.mode}, token file mode ${(file.mode & 0o777).toString(8)}, directory mode ${(dir.mode & 0o777).toString(8)}${up ? "" : ", NOT answering"}`];
  });
} else console.log("note  no TAKE_STATUS: the take's own 03 server is not checked");

if (api) {
  // The only approved disk is the scratch disk. If a feed ever names another, nothing is adopted: stop and tell the lead.
  const APPROVED = { disk: "dsk-00000000000baf76", region: "aws-us-east-1" };
  await check("the live feed's winner names the approved disk and region (anything else: stop and tell the lead)", async () => {
    const res = await fetch(`${api}/api/winner`, { signal: AbortSignal.timeout(4000) });
    if (res.status === 404) return [true, "no winner yet: nothing to adopt"];
    const w = await res.json();
    return [w.disk === APPROVED.disk && w.region === APPROVED.region, `${w.disk} in ${w.region}`];
  });
}
if (api) {
  await check(`the live feed answers (${api})`, async () => {
    const s = await (await fetch(`${api}/api/state`, { signal: AbortSignal.timeout(4000) })).json();
    return [Array.isArray(s.environments), `run ${s.run}, source ${s.source ?? "live"}, ${Object.keys(s.universes ?? {}).length} universes, place ${s.place?.where}`];
  });
} else console.log("note  no SHOW_API: the stage will play its scripted feed (badged SCRIPTED)");
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
