// The stage under /show/ survives the network going away: the checkout caches the files /show/offline.json lists, and a stage page opened (or reloaded) with no network is answered from the cache,
// cross-origin isolated (one origin with the agent's tab, so window.open between them keeps its handle: D5 measured that). Real Chrome, `?brain=off` (no model: this checks the cache and the origin, not the 1B).
//   [CDP=http://127.0.0.1:9334] [TMPDIR=<roomy dir>] node scripts/show-offline-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "show-offline-"));
const stage = join(dir, "stage");
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "index.html"), `<!doctype html><title>stage</title><body><h1 id="h">the stage</h1><script src="/show/main.js"></script>`);
writeFileSync(join(stage, "main.js"), `document.getElementById("h").dataset.js = "loaded"; window.__isolated = crossOriginIsolated;`);
writeFileSync(join(stage, "offline.json"), JSON.stringify({ files: ["/show/", "/show/main.js"] }));
const port = await freePort();
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", join(dir, "disk"), "--run", "sh", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--show-dir", stage, "--grace-ms", "3000"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
let page: Awaited<ReturnType<typeof device.open>> | undefined;
let stagePage: Awaited<ReturnType<typeof device.open>> | undefined;
const origin = `http://127.0.0.1:${port}`;
try {
  stagePage = await device.open(`${origin}/show/`);
  ok("online: the stage is served under /show/ on the tab's origin, isolated, and its script ran", (await stagePage.evaluate<string>("document.getElementById('h').dataset.js")) === "loaded" && (await stagePage.evaluate<boolean>("window.__isolated")) === true);
  page = await device.open(`${origin}${link}`.replace("#", "?brain=off#"));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await page.evaluate("document.getElementById('connection').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 300_000, 500);
  ok("the run was checked out", (await page.evaluate<string>("demo.state.mode")) === "offline", await page.evaluate("demo.state.banner"));
  const cached = await page.evaluate<string[]>(`caches.open("walks-home-offline-v1").then((c) => c.keys()).then((ks) => ks.map((k) => new URL(k.url).pathname).filter((p) => p.startsWith("/show/")))`);
  ok("the checkout cached the stage's files /show/offline.json lists", cached.includes("/show/") && cached.includes("/show/main.js"), cached);

  // the server goes away; the stage page is reloaded, and a second one opened, with no network
  server.kill("SIGKILL");
  await new Promise((r) => server.once("exit", r));
  await stagePage.send("Page.reload");
  await sleep(1500);
  await stagePage.until(`document.readyState === "complete" && document.getElementById("h") && document.getElementById("h").dataset.js === "loaded"`, 60_000, 500).catch(() => undefined);
  ok("offline: a reload of the stage is answered from the cache, its script runs, and the page is cross-origin isolated", (await stagePage.evaluate<string>("document.getElementById('h')?.dataset.js ?? 'no'")) === "loaded" && (await stagePage.evaluate<boolean>("window.__isolated")) === true, await stagePage.evaluate("document.body.innerText"));
  const second = await device.open(`${origin}/show/`).catch((e: Error) => e);
  ok("offline: a stage page opened fresh is answered from the cache too", !(second instanceof Error) && (await (second as typeof stagePage)!.evaluate<string>("document.getElementById('h')?.dataset.js ?? 'no'")) === "loaded", second instanceof Error ? second.message : "");
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
}
await device.close().catch(() => undefined);
cdp.close();
server.kill("SIGKILL");
rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
