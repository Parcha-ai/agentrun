// Hill 1b: does the in-browser computer (Wasmer + the computer's package) boot with the network off, and keep its workspace? Real Chrome, a local server that is then killed,
// CDP offline with WebSockets blocked: a run is checked out with ?brain=off (no model: this checks the computer alone), the page is reloaded with no network, the sandbox boots
// from the service worker's cache, the workspace comes back from OPFS, bash and node run, a file is written, the page is reloaded again and the file is still there.
//   [CDP=http://127.0.0.1:9333] [SHOTS=/tmp] node scripts/offline-computer-check.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { Cdp, type Page } from "./cdp.ts";

/** A port nothing holds now (asked of the system, not guessed). */
const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });

const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
let tarpit: NetServer | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "offline-computer-"));
const serverPort = await freePort();
const server = spawn(process.execPath, ["serve.ts", "--port", String(serverPort), "--local", dir, "--run", "comp", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
// What the cleanup has to undo is declared before anything can fail: a setup that throws (no run link, no browser) still ends the server and removes the directory.
let cdpConn: Cdp | undefined;
let deviceConn: Awaited<ReturnType<Cdp["device"]>> | undefined;
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
let page: Page | undefined;
const ev = <T>(expr: string) => page!.evaluate<T>(expr);
type Run = { exitCode?: number; output?: string; error?: string; ms?: number };
const exec = (command: string) => ev<Run>(`demo.exec(${JSON.stringify(command)})`);
const foreign: string[] = [];
const failedRequests: string[] = [];
try {
  for (let i = 0; i < 100 && !link; i++) await sleep(100);
  if (!link) throw new Error("the server printed no run link");
  const cdp = (cdpConn = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9333"));
  const device = (deviceConn = await cdp.device());
  const url = `http://127.0.0.1:${serverPort}${link}`.replace("#", "?brain=off#");
  page = await device.open(url);
  await page.send("Network.enable");
  const urlOf = new Map<string, string>();
  cdp.on("Network.requestWillBeSent", (p, session) => { if (session !== page!.sessionId) return; const u = String((p.request as { url: string }).url); urlOf.set(String(p.requestId), `${String(p.type)} ${u.slice(0, 110)}`); if (!u.startsWith(`http://127.0.0.1:${serverPort}`) && !u.startsWith("data:") && !u.startsWith("blob:")) foreign.push(u); });
  const started = new Map<string, number>();
  const slow: string[] = [];
  const unavailable: string[] = [];
  cdp.on("Network.requestWillBeSent", (p, session) => { if (session === page!.sessionId) started.set(String(p.requestId), Number(p.timestamp)); });
  cdp.on("Network.loadingFinished", (p, session) => { if (session !== page!.sessionId) return; const t = started.get(String(p.requestId)); if (t !== undefined && Number(p.timestamp) - t > 1.5) slow.push(`${urlOf.get(String(p.requestId)) ?? "?"} ${(Number(p.timestamp) - t).toFixed(1)}s`); });
  cdp.on("Network.responseReceived", (p, session) => { if (session === page!.sessionId && Number((p.response as { status: number }).status) === 504) unavailable.push(String((p.response as { url: string }).url)); });
  cdp.on("Network.loadingFailed", (p, session) => { if (session !== page!.sessionId) return; failedRequests.push(`${String(p.errorText)} ${String(p.blockedReason ?? "")} <- ${urlOf.get(String(p.requestId)) ?? "?"}`.trim()); });
  const onlineStart = Date.now();
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  console.log(`${at()} s: the agent runs in the tab with its computer (${((Date.now() - onlineStart) / 1000).toFixed(1)} s, online)`);
  console.log(`failed requests while online, so far: ${JSON.stringify([...new Set(failedRequests)])}`);
  const online = await exec("ls -a && node -e 'console.log(6*7)'");
  ok("online: bash and node run on the computer", online.exitCode === 0 && /42/.test(online.output ?? ""), online);
  await exec("mkdir -p notes && echo 'made online' > notes/online.txt");

  const clicked = Date.now();
  await ev("document.getElementById('offline').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 600_000, 500);
  const first = await ev<{ mode: string; record: { workspace: { files: number; bytes: number }; persistent: boolean }; banner: string }>("demo.offline()");
  ok("taking it offline (no model) worked", first.mode === "offline", first);
  console.log(`${at()} s: checked out (${((Date.now() - clicked) / 1000).toFixed(1)} s from the click); workspace saved ${JSON.stringify(first.record?.workspace)}; persistent storage granted: ${first.record?.persistent}`);
  const usage = await ev<{ usage: number; quota: number }>("navigator.storage.estimate()");
  console.log(`storage used after the checkout: ${(usage.usage / 1e6).toFixed(0)} MB of ${(usage.quota / 1e6).toFixed(0)} MB quota`);
  const c1 = await ev<{ booted: boolean; ms: number; files: number; error?: string } | null>("demo.computer()");
  ok("the computer boots in the same page after the handover, from the cache and OPFS", c1?.booted === true, c1);

  // ---- the network is cut for real
  server.kill("SIGKILL");
  await new Promise((r) => server.once("exit", r));
  if (process.env.TARPIT) {
    // a laptop with Wi-Fi off and an ssh -L tunnel still alive: the port ACCEPTS the connection and never answers
    tarpit = createNetServer((socket) => { socket.on("error", () => undefined); });
    await new Promise<void>((r) => tarpit!.listen(serverPort, "127.0.0.1", () => r()));
    console.log("the server's port now accepts and never answers (TARPIT)");
  }
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  foreign.length = 0; failedRequests.length = 0;

  // ---- reload 1, no network
  const reload1 = Date.now();
  await page.send("Page.reload");
  await sleep(1000);
  await page.until("globalThis.demo && demo.state.mode === 'offline' && demo.computer() !== null", 300_000, 500);
  const bootWall = Date.now() - reload1;
  const c2 = await ev<{ booted: boolean; ms: number; files: number; error?: string }>("demo.computer()");
  console.log(`${at()} s: reloaded with no network; page up and computer ${c2.booted ? "booted" : "NOT booted"} in ${(bootWall / 1000).toFixed(1)} s (the computer itself ${(c2.ms / 1000).toFixed(1)} s: ${JSON.stringify((c2 as { parts?: unknown }).parts)}), ${c2.files} files restored; isolated: ${await ev("crossOriginIsolated")}`);
  ok("reload with no network: the sandbox boots from the cache", c2.booted === true, c2);
  ok("the page is cross-origin isolated", await ev<boolean>("crossOriginIsolated"));
  const ls = await exec("ls -a /workspace && cat notes/online.txt");
  ok("the workspace came back from OPFS: the file made online is there", ls.exitCode === 0 && /notes/.test(ls.output ?? "") && /made online/.test(ls.output ?? ""), ls);
  const sum = await exec("node -e 'console.log(1+1)'");
  ok("node runs with no network", sum.exitCode === 0 && (sum.output ?? "").trim() === "2", sum);
  console.log(`node -e: ${sum.ms} ms; ls: ${ls.ms} ms`);
  const wrote = await exec("echo 'written offline' > offline.txt && cat offline.txt");
  ok("bash writes a file", wrote.exitCode === 0 && /written offline/.test(wrote.output ?? ""), wrote);
  await ev("demo.flush()");
  await ev("demo.writeFile('notes/second.txt', 'second, from the page')");
  await page.screenshot(join(shots, "computer-1-offline.png"));

  // ---- reload 2: the file is still there
  const reload2 = Date.now();
  await page.send("Page.reload");
  await sleep(1000);
  await page.until("globalThis.demo && demo.state.mode === 'offline' && demo.computer() !== null", 300_000, 500);
  const c3 = await ev<{ booted: boolean; ms: number; files: number; error?: string }>("demo.computer()");
  console.log(`${at()} s: reloaded again (${((Date.now() - reload2) / 1000).toFixed(1)} s); computer ${(c3.ms / 1000).toFixed(1)} s ${JSON.stringify((c3 as { parts?: unknown }).parts)}, ${c3.files} files restored`);
  const again = await exec("cat offline.txt notes/online.txt notes/second.txt");
  ok("after the second reload the files written offline are still there", again.exitCode === 0 && /written offline/.test(again.output ?? "") && /made online/.test(again.output ?? "") && /second, from the page/.test(again.output ?? ""), again);
  console.log(`timeline of the last page load (ms from navigation start): ${JSON.stringify(await ev(`performance.getEntriesByType('resource').map((r) => [r.name.replace(location.origin, '').slice(0, 48), Math.round(r.startTime), Math.round(r.responseEnd)]).sort((a, b) => a[1] - b[1])`))}`);
  console.log(`the service worker's journal: ${JSON.stringify(await ev(`new Promise((resolve) => { navigator.serviceWorker.addEventListener("message", (e) => resolve(e.data.journal.filter((l) => !l.startsWith("cache 0") && !/^breaker [0-5]ms/.test(l)).slice(-40))); navigator.serviceWorker.controller.postMessage({ type: "log" }); })`))}`);
  console.log(`requests slower than 1.5 s while offline: ${JSON.stringify([...new Set(slow)])}`);
  console.log(`requests the worker answered 504 (not cached, no network): ${JSON.stringify([...new Set(unavailable)])}`);
  console.log(`iframes in the page: ${JSON.stringify(await ev("[...document.querySelectorAll('iframe')].map((f) => f.src || f.srcdoc.slice(0, 60))"))}`);
  console.log(`resources not from this origin: ${JSON.stringify(await ev(`performance.getEntriesByType('resource').map((r) => r.name).filter((n) => !n.startsWith(location.origin) && !n.startsWith('blob:') && !n.startsWith('data:'))`))}`);
  console.log(`workers in the page's resources: ${JSON.stringify(await ev(`performance.getEntriesByType('resource').filter((r) => /worker|\\.wasm|webc/.test(r.name)).map((r) => r.name.replace(location.origin, '') + ' ' + Math.round(r.duration) + 'ms')`))}`);
  const errors = page.console.filter((l) => /exception|error|Failed|blocked|Refused/i.test(l) && !/WebGPU/.test(l)).slice(-8);
  console.log(`requests to other origins while offline: ${JSON.stringify([...new Set(foreign)])}`);
  console.log(`failed requests while offline: ${JSON.stringify([...new Set(failedRequests)].slice(0, 6))}`);
  if (errors.length) console.log(`page console (errors): ${JSON.stringify(errors)}`);
  await page.screenshot(join(shots, "computer-2-reloaded.png"));
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, progress: demo.state.progress, computer: demo.computer() }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-12).join("\n"));
    console.log(`foreign: ${JSON.stringify([...new Set(foreign)])}; failed: ${JSON.stringify([...new Set(failedRequests)].slice(0, 6))}`);
    await page.screenshot(join(shots, "computer-failed.png")).catch(() => undefined);
  }
} finally {
  await deviceConn?.close().catch(() => undefined);
  cdpConn?.close();
  server.kill("SIGKILL");
  tarpit?.close();
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
