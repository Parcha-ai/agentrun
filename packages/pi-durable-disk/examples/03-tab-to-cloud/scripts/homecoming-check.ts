// Hill 6: adapters come home over one base. In real Chrome with the real wllama: the base comes home alone first (its manifest lists no adapter, so the page
// prefetches it while the agent trains), then the tool adapter (the brain swaps to base + tools), then a second adapter: its manifest lists both and makes the
// new one active, the page is closed and the link opened again in the same browser (a reload attaches as a viewer while the old page's writer is in its grace), and
// only that adapter is fetched. Bytes on the wire are counted per folder from the network events, apart from the page's
// own count. Last, one question to the new brain, to show which adapter is on.
//   HOME_DISK=<dir from make-home-disk.mjs with a base and two adapters> [FIRST=tools.gguf] [SECOND=moon.gguf] [ASK="..."] [CDP=http://127.0.0.1:9334] [TMPDIR=<roomy dir>] node scripts/homecoming-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";
import { fileDir } from "../../04-walks-home/tab/src/adapter-manifest.ts";

const HOME_DISK = process.env.HOME_DISK;
if (!HOME_DISK || !existsSync(join(HOME_DISK, "home/manifest.json"))) throw new Error("HOME_DISK must hold home/manifest.json, home/base and home/adapters");
type File = { sha256: string; chunk_bytes: number };
const full = JSON.parse(readFileSync(join(HOME_DISK, "home/manifest.json"), "utf8")) as { format: string; base: File & { size: number }; adapters: (File & { name: string; size: number; topic: string })[] };
const FIRST = process.env.FIRST ?? full.adapters[0]!.name, SECOND = process.env.SECOND ?? full.adapters[1]!.name;
const first = full.adapters.find((a) => a.name === FIRST)!, second = full.adapters.find((a) => a.name === SECOND)!;
const ASK = process.env.ASK ?? "What would you do with a free afternoon?";
const stem = (name: string) => name.replace(/\.gguf$/, "");
const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "homecoming-"));
const work = join(dir, "runs", "to", "work");
const port = await freePort();
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", "to", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
const url = `http://127.0.0.1:${port}${link}`.replace("#", "?threads=6#");
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
const wire = { base: 0, adapters: new Map<string, number>(), urls: new Map<string, string>() };
cdp.on("Network.requestWillBeSent", (p, session) => { if (session === page?.sessionId) wire.urls.set(p.requestId as string, (p.request as { url: string }).url); });
cdp.on("Network.loadingFinished", (p, session) => {
  if (session !== page?.sessionId) return;
  const u = wire.urls.get(p.requestId as string) ?? "";
  if (u.includes(`/work/${fileDir(full.base.sha256, full.base.chunk_bytes)}/`)) wire.base += p.encodedDataLength as number;
  const a = full.adapters.find((x) => u.includes(`/work/${fileDir(x.sha256, x.chunk_bytes)}/`));
  if (a) wire.adapters.set(stem(a.name), (wire.adapters.get(stem(a.name)) ?? 0) + (p.encodedDataLength as number));
});
const resetWire = () => { wire.base = 0; wire.adapters.clear(); };
const wireAdapters = () => Object.fromEntries(wire.adapters);
type Homecoming = { prefetch?: boolean; plan: { base: boolean; adapters: string[]; bytes: number }; fetched_bytes: number; fetch_ms: number; load_ms?: number; active?: Record<string, number> };
const homecomings = () => ev<Homecoming[]>("demo.homecomings()");
const writeManifest = (m: unknown) => { writeFileSync(join(work, "home/manifest.json.tmp"), JSON.stringify(m)); renameSync(join(work, "home/manifest.json.tmp"), join(work, "home/manifest.json")); };
const copy = (f: File) => cpSync(join(HOME_DISK, fileDir(f.sha256, f.chunk_bytes)), join(work, fileDir(f.sha256, f.chunk_bytes)), { recursive: true });

try {
  page = await device.open(url);
  await page.send("Network.enable");
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);

  // ---- 1: the base, alone in its manifest
  copy(full.base);
  writeManifest({ format: full.format, base: full.base, adapters: [] });
  let t = Date.now();
  await page.until("demo.homecomings().some((h) => h.prefetch)", 600_000, 500);
  const pre = (await homecomings()).find((h) => h.prefetch)!;
  console.log(`${at()} s: base: fetched ${mb(pre.fetched_bytes)} in ${(pre.fetch_ms / 1000).toFixed(1)} s (wall ${((Date.now() - t) / 1000).toFixed(1)} s, on the wire ${mb(wire.base)})`);
  ok("the base came home first, alone", pre.plan.base && pre.fetched_bytes === full.base.size && wire.base >= full.base.size, { pre, wire: wire.base });
  ok("no brain yet: nothing to swap to", (await ev<{ swapped: boolean }>("demo.brain()")).swapped === false);

  // ---- 2: the first adapter, over the cached base
  resetWire();
  copy(first);
  writeManifest({ format: full.format, base: full.base, adapters: [first], active: [FIRST] });
  t = Date.now();
  await page.until("demo.brain().swapped === true", 400_000, 1000);
  const one = (await homecomings()).filter((h) => !h.prefetch).at(-1)!;
  const conv1 = (await ev<{ conversation: string }>("demo.brain()")).conversation;
  console.log(`${at()} s: ${FIRST}: fetched ${mb(one.fetched_bytes)} in ${(one.fetch_ms / 1000).toFixed(1)} s, loaded in ${((one.load_ms ?? 0) / 1000).toFixed(1)} s, swapped ${((Date.now() - t) / 1000).toFixed(1)} s after the manifest; on the wire: base ${mb(wire.base)}, adapters ${JSON.stringify(wireAdapters())}`);
  ok(`${FIRST} came home alone over the cached base`, !one.plan.base && one.plan.adapters.join() === FIRST && one.fetched_bytes === first.size && wire.base === 0, { one, base: wire.base });

  // ---- 3: the second adapter: the manifest lists both and makes it active; the page is closed and the link opened again (the same browser, its OPFS), and only it is fetched
  resetWire();
  copy(second);
  writeManifest({ format: full.format, base: full.base, adapters: [first, second], active: [SECOND] });
  await page.close();
  await sleep(6000); // past the writer's grace (3 s): the run is nobody's, so opening the link runs it here
  t = Date.now();
  page = await device.open(url);
  await page.send("Network.enable");
  await page.until(`globalThis.demo && demo.state.mode === 'writer' && demo.brain().swapped === true && demo.brain().conversation !== ${JSON.stringify(conv1)}`, 400_000, 1000);
  const two = (await homecomings()).filter((h) => !h.prefetch).at(-1)!;
  console.log(`${at()} s: ${SECOND}: fetched ${mb(two.fetched_bytes)} in ${(two.fetch_ms / 1000).toFixed(1)} s, loaded (base + ${FIRST} + ${SECOND}) in ${((two.load_ms ?? 0) / 1000).toFixed(1)} s, swapped ${((Date.now() - t) / 1000).toFixed(1)} s after the page opened; on the wire: base ${mb(wire.base)}, adapters ${JSON.stringify(wireAdapters())}`);
  ok(`${SECOND} came home without the base: only it was fetched`, !two.plan.base && two.plan.adapters.join() === SECOND && two.fetched_bytes === second.size && wire.base === 0 && !wire.adapters.has(stem(FIRST)), { two, base: wire.base, adapters: wireAdapters() });
  ok(`${SECOND} is the active adapter, ${FIRST} loaded beside it at 0`, JSON.stringify(two.active) === JSON.stringify({ [SECOND]: 1 }), two.active);

  // ---- 4: one question to the new brain
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(ASK)}; document.getElementById("send").click(); return true; })()`);
  await sleep(3000);
  await page.until("!demo.state.chat.busy", 600_000, 1000);
  const items = await ev<{ kind: string; text?: string }[]>(`demo.items().slice(${before})`);
  const answer = items.filter((i) => i.kind !== "user").map((i) => i.text ?? "").join(" ").trim();
  console.log(`${at()} s: asked ${JSON.stringify(ASK)}; the brain with ${SECOND} on (${second.topic}) answered: ${JSON.stringify(answer.slice(0, 400))}`);
  ok("the new brain answered", answer.length > 0, items);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ brain: demo.brain(), mode: demo.state.mode, banner: demo.state.banner, homecomings: demo.homecomings(), items: demo.items().slice(-5).map(i => ({ kind: i.kind, text: String(i.text ?? i.name ?? '').slice(0, 160) })) }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-12).join("\n"));
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
