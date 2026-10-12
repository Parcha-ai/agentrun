// Hill 3: the tool model, offline. A run in ONE conversation (?configure=1) is checked out to the browser, the network is cut for real (the server killed, CDP offline, WebSockets blocked), the
// model does "write hello.js and run it" on the in-browser computer with pi's real tools, the file lands in this browser's OPFS copy of the workspace, the page is reloaded with no network, the
// same conversation comes back, the file is still there, and the model can run it again.
//   MODEL_DISK=<dir holding home/model/manifest.json and the chunks> [CDP=http://127.0.0.1:9333] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/tools-offline-check.ts
// HOME_DISK=<dir from 04-walks-home/tab/scripts/make-home-disk.mjs> instead: the model comes home as a base and an adapter. The base first, alone in its manifest
// (the page prefetches it while the agent trains), then the adapter and the whole manifest: the check measures that only the adapter was fetched.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";
import { fileDir } from "../../04-walks-home/tab/src/adapter-manifest.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const MODEL_DISK = process.env.MODEL_DISK, HOME_DISK = process.env.HOME_DISK;
if (HOME_DISK ? !existsSync(join(HOME_DISK, "home/manifest.json")) : !MODEL_DISK || !existsSync(join(MODEL_DISK, "home/model/manifest.json"))) throw new Error("MODEL_DISK must hold home/model/manifest.json and the chunks (or HOME_DISK home/manifest.json, home/base and home/adapters)");
const shots = process.env.SHOTS ?? "/tmp";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "tools-offline-"));
const port = await freePort();
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--local", dir, "--run", "to", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", HOME_DISK ? "home/" : "home/model/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
const url = `http://127.0.0.1:${port}${link}`.replace("#", "?configure=1&threads=6#");
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string };
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
const send = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(3000);
  await page!.until(idle, 900_000, 2000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
/** Bytes this page received for the run's model files, the base's folder apart from the adapters', from the network events: the page's own count is checked against it. */
const wire = { base: 0, adapters: 0, urls: new Map<string, string>(), baseDir: "" };
cdp.on("Network.requestWillBeSent", (p, session) => { if (session === page?.sessionId) wire.urls.set(p.requestId as string, (p.request as { url: string }).url); });
cdp.on("Network.loadingFinished", (p, session) => {
  if (session !== page?.sessionId) return;
  const u = wire.urls.get(p.requestId as string) ?? "";
  if (wire.baseDir && u.includes(`/work/${wire.baseDir}/`)) wire.base += p.encodedDataLength as number;
  else if (u.includes("/work/" + "home/files/")) wire.adapters += p.encodedDataLength as number;
});
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
type Homecoming = { prefetch?: boolean; plan: { base: boolean; adapters: string[]; bytes: number }; fetched_bytes: number; fetch_ms: number; load_ms?: number };
async function comeHome(): Promise<void> {
  const work = join(dir, "runs", "to", "work");
  type File = { sha256: string; chunk_bytes: number };
  const full = JSON.parse(readFileSync(join(HOME_DISK!, "home/manifest.json"), "utf8")) as { base: File; adapters: (File & { name: string; size: number })[] };
  const copy = (f: File) => cpSync(join(HOME_DISK!, fileDir(f.sha256, f.chunk_bytes)), join(work, fileDir(f.sha256, f.chunk_bytes)), { recursive: true });
  wire.baseDir = fileDir(full.base.sha256, full.base.chunk_bytes);
  await page!.send("Network.enable");
  // the base, alone in its manifest: the page prefetches it while the agent trains
  copy(full.base);
  writeFileSync(join(work, "home/manifest.json"), JSON.stringify({ format: "gguf-base-adapters-v1", base: full.base, adapters: [] }));
  let t = Date.now();
  await page!.until("demo.homecomings().some((h) => h.prefetch)", 600_000, 500);
  const pre = (await ev<Homecoming[]>("demo.homecomings()")).find((h) => h.prefetch)!;
  console.log(`${at()} s: the base came home first: ${mb(pre.fetched_bytes)} in ${(pre.fetch_ms / 1000).toFixed(1)} s (wall ${((Date.now() - t) / 1000).toFixed(1)} s; on the wire ${mb(wire.base)})`);
  ok("the base's prefetch fetched the base", pre.plan.base && pre.fetched_bytes > 0 && wire.base >= pre.fetched_bytes, { pre, wire: wire.base });
  // then the adapter, and the whole manifest last: only the adapter comes home
  wire.base = 0; wire.adapters = 0;
  for (const a of full.adapters) copy(a);
  writeFileSync(join(work, "home/manifest.json.tmp"), readFileSync(join(HOME_DISK!, "home/manifest.json")));
  renameSync(join(work, "home/manifest.json.tmp"), join(work, "home/manifest.json"));
  t = Date.now();
  await page!.until("demo.brain().swapped === true", 400_000, 1000);
  const h = (await ev<Homecoming[]>("demo.homecomings()")).filter((x) => !x.prefetch).at(-1)!;
  const adapterBytes = full.adapters.reduce((n, a) => n + a.size, 0);
  console.log(`${at()} s: the adapter came home: fetched ${mb(h.fetched_bytes)} (${h.plan.adapters.join(", ")}) in ${(h.fetch_ms / 1000).toFixed(1)} s, loaded in ${((h.load_ms ?? 0) / 1000).toFixed(1)} s, swapped ${((Date.now() - t) / 1000).toFixed(1)} s after the manifest; on the wire: base ${mb(wire.base)}, adapters ${mb(wire.adapters)}`);
  ok("only the adapter came home: the base was not fetched again", !h.plan.base && h.fetched_bytes === adapterBytes && wire.base === 0 && wire.adapters >= adapterBytes, { h, wire: { base: wire.base, adapters: wire.adapters }, adapterBytes });
}
try {
  page = await device.open(url);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  if (HOME_DISK) await comeHome();
  else {
    const dest = join(dir, "runs", "to", "work/home/model");
    mkdirSync(dest, { recursive: true });
    for (const n of readdirSync(join(MODEL_DISK!, "home/model")).sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)))) copyFileSync(join(MODEL_DISK!, "home/model/", n), join(dest, n));
    await page.until("demo.brain().swapped === true", 400_000, 1000);
  }
  const conv = (await ev<{ conversation: string }>("demo.brain()")).conversation;
  console.log(`${at()} s: the model is the brain of conversation ${conv}`);

  // ---- take it offline (the checkout on top of configure), then cut the network
  await ev("document.getElementById('offline').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 600_000, 1000);
  ok("the checkout worked on a configured conversation", (await ev<string>("demo.state.mode")) === "offline", await ev("demo.state.banner"));
  await page.until("demo.brain().swapped === true", 200_000, 500);
  ok("the same conversation is the model's after the handover", (await ev<{ conversation: string }>("demo.brain()")).conversation === conv);
  server.kill("SIGKILL");
  await new Promise((r) => server.once("exit", r));
  await page.send("Network.enable");
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  console.log(`${at()} s: network cut`);

  // ---- the model works, offline
  const items = await send("Write hello.js that prints hi, then run it.");
  const turns = await ev<{ ms: number; call: string | null; problem: string | null; raw: string }[]>("demo.toolTurns()");
  for (const t of turns) console.log(`  turn ${(t.ms / 1000).toFixed(1)} s: ${t.call ? "call " + t.call.slice(0, 160) : "answer"}${t.problem ? " PROBLEM " + t.problem : ""}`);
  for (const i of items.filter((x) => x.kind === "tool")) console.log(`  [tool ${i.status}] ${i.name} -> ${JSON.stringify((i.output ?? "").slice(0, 100))}`);
  ok("the model made tool calls offline and pi's real tools ran them", items.some((i) => i.kind === "tool" && i.status === "done"), items.map((i) => `${i.kind}:${i.status ?? ""}`));
  const run1 = await ev<{ exitCode?: number; output?: string }>("demo.exec('node hello.js')");
  ok("hello.js exists on the computer and prints hi", run1.exitCode === 0 && (run1.output ?? "").trim() === "hi", run1);
  const saved1 = await ev<{ path: string; text: string | null }[]>("demo.saved()");
  ok("the file landed in this browser's OPFS copy of the workspace", saved1.some((f) => f.path === "hello.js" && /console\.log/.test(f.text ?? "")), saved1);
  const entriesBefore = (await ev<{ kind: string }[]>("demo.items()")).filter((i) => i.kind === "tool").length;
  await page.screenshot(join(shots, "tools-offline-1.png"));

  // ---- reload with no network
  await page.send("Page.reload");
  await sleep(1500);
  await page.until("globalThis.demo && demo.state.mode === 'offline' && demo.computer() !== null && demo.brain().swapped === true", 400_000, 1000);
  console.log(`${at()} s: reloaded offline`);
  ok("the reload comes back cross-origin isolated", await ev<boolean>("crossOriginIsolated"));
  ok("the SAME conversation", (await ev<{ conversation: string }>("demo.brain()")).conversation === conv, await ev("demo.brain()"));
  ok("what happened is still in it: the tool calls", (await ev<{ kind: string }[]>("demo.items()")).filter((i) => i.kind === "tool").length === entriesBefore, entriesBefore);
  const run2 = await ev<{ exitCode?: number; output?: string }>("demo.exec('node hello.js')");
  ok("the file is still on the computer after the reload", run2.exitCode === 0 && (run2.output ?? "").trim() === "hi", run2);

  // ---- and the model can use it again
  const turnsBefore = (await ev<unknown[]>("demo.toolTurns()")).length;
  const again = await send("Write hello2.js that prints hi, then run it.");
  for (const t of (await ev<{ ms: number; call: string | null; problem: string | null; raw: string }[]>("demo.toolTurns()")).slice(turnsBefore)) console.log(`  turn ${(t.ms / 1000).toFixed(1)} s: ${t.call ? "call " + t.call.slice(0, 160) : "answer " + JSON.stringify(t.raw.slice(0, 200))}${t.problem ? " PROBLEM " + t.problem : ""}`);
  console.log(`  chat after: ${JSON.stringify(again.map((i) => `${i.kind}${i.status ? ":" + i.status : ""}`))}`);
  if (process.env.SHOW_PROMPT) { const last = (await ev<{ prompt: string }[]>("demo.toolTurns()")).at(-1)!.prompt; console.log(`PROMPT (${last.length} chars):\n${last.slice(0, 300)}\n...\n${last.slice(-1500)}`); }
  const ran = again.filter((i) => i.kind === "tool");
  for (const i of ran) console.log(`  [tool ${i.status}] ${i.name} -> ${JSON.stringify((i.output ?? "").slice(0, 100))}`);
  ok("after the reload the model runs a tool", ran.some((i) => i.status === "done"), ran);
  const saved2 = await ev<{ path: string; text: string | null }[]>("demo.saved()");
  ok("its new file landed in OPFS beside the old one", saved2.some((f) => f.path === "hello2.js" && /console\.log/.test(f.text ?? "")) && saved2.some((f) => f.path === "hello.js"), saved2.map((f) => f.path));
  await page.screenshot(join(shots, "tools-offline-2.png"));
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ brain: demo.brain(), mode: demo.state.mode, banner: demo.state.banner, items: demo.items().slice(-5).map(i => ({ kind: i.kind, text: String(i.text ?? i.name ?? '').slice(0, 120) })), turns: demo.toolTurns().slice(-2) }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-12).join("\n"));
    await page.screenshot(join(shots, "tools-offline-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
