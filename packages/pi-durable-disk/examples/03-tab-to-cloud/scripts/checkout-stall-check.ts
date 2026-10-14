// "Take it offline" in real Chrome while the tab's main thread stalls for longer than the writer grace: the tab says `checkout-begin`, the server holds it as the writer, and the checkout finishes.
// The stall is a synchronous loop of STALL_MS (default 6000, past the server's default grace of 5000) in the step that saves the workspace into OPFS, with no ping or frame leaving the tab meanwhile.
// Before the hold it ended with "no ping from the tab": the writer retired in the middle of the checkout and the page fell back to a viewer.
//   [CDP=http://127.0.0.1:9334] [STALL_MS=6000] [GRACE_MS=<writer grace; the server's own default when unset>] [TMPDIR=<roomy dir>] node scripts/checkout-stall-check.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stallMs = Number(process.env.STALL_MS ?? 6000);
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const here = import.meta.dirname;
const fixture = join(here, "../../04-walks-home/policy/test/fixtures/policy.json");
const policyText = readFileSync(fixture, "utf8");
const sha = (JSON.parse(policyText) as { mjcf_sha256: string }).mjcf_sha256;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "checkout-stall-"));
const port = await freePort();
const RUN = "cs";
const work = join(dir, "runs", RUN, "work");
mkdirSync(join(work, "home/skills"), { recursive: true });
copyFileSync(fixture, join(work, "home/policy.json"));
for (const n of ["walk", "sprint"]) copyFileSync(fixture, join(work, `home/skills/${n}.json`));
writeFileSync(join(work, "home/skills.json"), JSON.stringify({ version: 1, body_mjcf_sha256: sha, default: "walk", skills: { walk: { policy: "skills/walk.json", command: 0.3, label: "walk" }, sprint: { policy: "skills/sprint.json", command: 0.7, label: "sprint" } } }));
let server: ChildProcess | undefined;
let cdp: Cdp | undefined;
let device: Awaited<ReturnType<Cdp["device"]>> | undefined;
let link = "";
const serverLog: string[] = [];
let page: Awaited<ReturnType<Awaited<ReturnType<Cdp["device"]>>["open"]>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
try {
  server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--no-restore", "home/files/", "--no-restore", "home/model/", ...(process.env.GRACE_MS ? ["--grace-ms", process.env.GRACE_MS] : [])], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
  server.stderr!.on("data", (d) => serverLog.push(String(d)));
  for (let i = 0; i < 100 && !link; i++) await sleep(100);
  if (!link) throw new Error("the server printed no run link");
  cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
  device = await cdp.device();
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1&robotcode=0&brain=off#"));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  // The frames the tab sends, and a stall in the step that saves the workspace (the one removeEntry of work-<run>), armed here: the loop blocks the page's thread, so no ping can leave meanwhile.
  await ev(`(() => {
    window.__frames = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (...a) { window.__frames.push(Math.round(performance.now())); return send.apply(this, a); };
    window.__stalled = null;
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = function (name, ...rest) {
      if (window.__stalled === null && String(name).startsWith("work-")) { const t = performance.now(); while (performance.now() - t < ${stallMs}); window.__stalled = Math.round(performance.now() - t); }
      return remove.call(this, name, ...rest);
    };
    return true;
  })()`);
  await ev("document.getElementById('connection').click()");
  await page.until("demo.state.mode === 'offline' || demo.state.mode === 'viewer' || demo.state.mode === 'lost' || /could not take it offline/.test(demo.state.banner)", 300_000, 500);
  const after = await ev<{ mode: string; banner: string; stalled: number | null; gap: number }>(`(() => { const f = window.__frames; let gap = 0; for (let i = 1; i < f.length; i++) gap = Math.max(gap, f[i] - f[i - 1]); return { mode: demo.state.mode, banner: demo.state.banner, stalled: window.__stalled, gap }; })()`);
  ok(`the tab's main thread stalled for ${stallMs} ms inside the checkout, and no frame left it meanwhile`, after.stalled !== null && after.stalled >= stallMs - 200 && after.gap >= stallMs - 500, after);
  ok("the run was checked out: the writer was held through the stall, not retired for sending no ping", after.mode === "offline", after);
  ok("and the page did not fall back to a viewer", !/no ping from the tab/.test(after.banner), after);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner }) : 'no demo')").catch(() => "page gone")));
  console.log(serverLog.join("").split("\n").filter((l) => /grace|storage-read|writer/i.test(l)).slice(-5).join("\n"));
} finally {
  await device?.close().catch(() => undefined);
  cdp?.close();
  server?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
