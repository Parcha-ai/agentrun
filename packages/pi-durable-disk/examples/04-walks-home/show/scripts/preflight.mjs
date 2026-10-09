// Live-day preflight: every way the stage has gone wrong in rehearsal, checked in one run, so a surprise is a line of output
// before the take and not a blank pane during it.
//   CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> POLICY_DIR=<dir> [SHOW_API=http://host:port] node scripts/preflight.mjs
// Exits non-zero if any check fails. Reads and probes only: it starts nothing and spends nothing.
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const tabDir = process.env.TAB_DIR;
const policyDir = process.env.POLICY_DIR ?? join(here, "..", "page", "policy");
const api = process.env.SHOW_API?.replace(/\/$/, "");
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
await check("the winner's policy is there, mlp-v1, for this MuJoCo", () => {
  const f = join(policyDir, "home.json");
  if (!existsSync(f)) return [false, `no ${f}: the home beat would show a refused policy`];
  const p = JSON.parse(readFileSync(f, "utf8"));
  return [p.format === "mlp-v1" && p.mujoco_version === "3.15.0" && typeof p.mjcf_sha256 === "string", `${p.format}, MuJoCo ${p.mujoco_version}, ${Math.round(statSync(f).size / 1000)} KB`];
});
await check("the 03 tab page is built and newer than its sources (an old one never times a switch back)", () => {
  const dist = join(ex03, "tab", "dist", "main.js");
  if (!existsSync(dist)) return [false, "node tab/build.mjs --fetch in 03-tab-to-cloud"];
  const src = Math.max(newest(join(ex03, "tab")), statSync(join(ex03, "wire.ts")).mtimeMs, statSync(join(ex03, "environment.ts")).mtimeMs);
  return statSync(dist).mtimeMs < src - 1000 ? [false, "tab/dist is older than its sources: rebuild it"] : true;
});
await check("the model broker answers (the agent's answers after a switch)", async () => (await fetch("http://127.0.0.1:9421/v1/models", { signal: AbortSignal.timeout(4000) })).ok);

if (api) {
  await check(`the live feed answers (${api})`, async () => {
    const s = await (await fetch(`${api}/api/state`, { signal: AbortSignal.timeout(4000) })).json();
    return [Array.isArray(s.environments), `run ${s.run}, source ${s.source ?? "live"}, ${Object.keys(s.universes ?? {}).length} universes, place ${s.place?.where}`];
  });
} else console.log("note  no SHOW_API: the stage will play its scripted feed (badged SCRIPTED)");
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
