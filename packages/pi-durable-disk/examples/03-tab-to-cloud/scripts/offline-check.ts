// A run checked out to a browser, in real Chrome, with the real trained model: two turns online, "Take it offline", then the network is cut for real (the server process
// is killed, CDP emulates offline and blocks WebSockets), two more turns on the model, a reload with no network that comes back cross-origin isolated on the same
// conversation, and two turns after it. The store head the server released is the head the page's copy holds.
//   MODEL_DISK=<dir holding home/model/manifest.json and the chunks> [CDP=http://127.0.0.1:9333] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/offline-check.ts
// Debugging: NO_CUT=1 leaves the network alone; HOLD=1 keeps the page and the server up for 15 minutes after a failure.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const MODEL_DISK = process.env.MODEL_DISK;
if (!MODEL_DISK || !existsSync(join(MODEL_DISK, "home/model/manifest.json"))) throw new Error("MODEL_DISK must hold home/model/manifest.json and the chunks");
const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "offline-check-"));
const serverPort = 20000 + Math.floor(Math.random() * 20000);
// a model endpoint nothing answers on: the run's model proxy is never used (the trip is not part of this check)
const server = spawn(process.execPath, ["serve.ts", "--port", String(serverPort), "--local", dir, "--run", "off", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/model/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
children.push(server);
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");

const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9333");
const device = await cdp.device();
const url = `http://127.0.0.1:${serverPort}${link}`.replace("#", "?threads=6#");
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(expr: string) => page!.evaluate<T>(expr);
const ask = async (text: string, timeout = 240_000) => {
  const before = await ev<number>("demo.items().filter(i => i.kind === 'assistant').length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await page!.until(`demo.items().filter(i => i.kind === 'assistant').length > ${before} && demo.state.chat.busy === false`, timeout, 500);
  return ev<{ thinking: string; text: string }>("(() => { const a = demo.items().filter(i => i.kind === 'assistant'); const l = a[a.length - 1]; return { thinking: l.thinking, text: l.text }; })()");
};
const headOf = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return (db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as { next_seq: number }).next_seq - 1; } finally { db.close(); } };
try {
  page = await device.open(url);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 120_000, 500);
  console.log(`${at()} s: the agent runs in the tab`);
  const dest = join(dir, "runs", "off", "work/home/model");
  mkdirSync(dest, { recursive: true });
  const names = readdirSync(join(MODEL_DISK, "home/model")).sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)));
  for (const n of names) copyFileSync(join(MODEL_DISK, "home/model", n), join(dest, n));
  await page.until("demo.brain().swapped === true", 300_000, 1000);
  console.log(`${at()} s: the trained model is the brain`);
  const conversation = (await ev<{ conversation: string }>("demo.brain()")).conversation;
  ok("the checkout button shows once the trained model is the brain", await ev<boolean>("!document.getElementById('offline').hidden"));
  const a1 = await ask("Who are you?");
  const a2 = await ask("what is the sun?");
  ok("two turns online: thinking above a real answer each", a1.thinking.length > 5 && a1.text.length > 5 && a2.text.length > 5, { a1, a2 });
  const onlineUsers = (await ev<{ kind: string }[]>("demo.items()")).filter((i) => i.kind === "user").length;

  // ---- take it offline
  await ev("document.getElementById('offline').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 600_000, 1000);
  const banner = await ev<string>("demo.state.banner");
  ok("taking it offline worked", banner === "", banner);
  await page.until("demo.brain().swapped === true", 120_000, 500);
  console.log(`${at()} s: checked out, running from this browser`);
  const off1 = await ev<{ mode: string; record: { state: string; head: number; conversation: number; model: string }; head: number; isolated: boolean; panel: { hidden: boolean; text: string } }>("demo.offline()");
  ok("the page says it is checked out to this browser, with what does not work", off1.mode === "offline" && !off1.panel.hidden && /Checked out to this browser/.test(off1.panel.text) && /Moves/.test(off1.panel.text) && /Jev and the safety check/.test(off1.panel.text) && /Viewers and operators/.test(off1.panel.text) && /Sync back: none/.test(off1.panel.text), off1.panel);
  ok("the same conversation carries on in the same page", (await ev<{ conversation: string }>("demo.brain()")).conversation === conversation);
  const released = headOf(join(dir, "runs", "off", "store", "run.sqlite"));
  const marker = JSON.parse(readFileSync(join(dir, "runs", "off", "store", "checkout.json"), "utf8")) as { head: number; conversation: number };
  ok("the store head the server released is the head the page's copy was taken at", released === off1.record.head && marker.head === released, { released, record: off1.record.head, marker: marker.head });
  ok("the mark on the disk names the conversation", marker.conversation === Number(conversation), { marker: marker.conversation, conversation });
  ok("the page's own store is at that head (nothing committed since the handover)", off1.head >= off1.record.head, off1);
  await page.screenshot(join(shots, "offline-1-checked-out.png"));

  // ---- cut the network for real: the server is gone, the browser is offline, no WebSocket opens
  if (!process.env.NO_CUT) {
    server.kill("SIGKILL");
    await new Promise((r) => server.once("exit", r));
    await page.send("Network.enable");
    await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  }
  const probe = await ev<{ socket: string; api: number | string; online: boolean }>(`(async () => {
    const socket = await new Promise((resolve) => { try { const w = new WebSocket("ws://127.0.0.1:${serverPort}/ws"); w.onopen = () => resolve("open"); w.onerror = () => resolve("blocked"); w.onclose = () => resolve("blocked"); } catch (e) { resolve("blocked"); } });
    const api = await fetch("/api/runs/off/judge", { method: "POST", body: "{}" }).then((r) => r.status, () => "failed");
    return { socket, api, online: navigator.onLine };
  })()`);
  ok("the network is cut: offline, a WebSocket cannot open, an uncached request fails", probe.socket === "blocked" && !probe.online && probe.api !== 200, probe);
  const b1 = await ask("what is the moon?");
  const b2 = await ask("tell me more");
  console.log(`${at()} s: offline turns -> ${JSON.stringify(b1.text.slice(0, 80))} | ${JSON.stringify(b2.text.slice(0, 80))}`);
  ok("two turns with no network, on the trained model, thinking above the answer", b1.thinking.length > 5 && b1.text.length > 5 && b2.text.length > 5, { b1, b2 });
  const mid = await ev<{ head: number }>("demo.offline()");
  ok("those turns were committed to the copy in this browser", mid.head > off1.head, { before: off1.head, after: mid.head });
  await page.screenshot(join(shots, "offline-2-offline-chat.png"));

  // ---- reload with no network
  await page.send("Page.reload");
  await sleep(1500);
  await page.until("globalThis.demo && demo.state.mode === 'offline'", 120_000, 500);
  console.log(`${at()} s: reloaded offline, the page is up`);
  await page.until("demo.brain().swapped === true", 300_000, 1000);
  console.log(`${at()} s: the model loaded from the cache`);
  const off2 = await ev<{ mode: string; isolated: boolean; head: number; record: { conversation: number } }>("demo.offline()");
  ok("the reload comes back cross-origin isolated (wllama gets its threads)", off2.isolated === true, off2);
  ok("the reload resumes the SAME conversation", (await ev<{ conversation: string }>("demo.brain()")).conversation === conversation, await ev("demo.brain()"));
  ok("what was said, online and offline, is all still there", (await ev<{ kind: string }[]>("demo.items()")).filter((i) => i.kind === "user").length === onlineUsers + 2, await ev("demo.items().length"));
  ok("the copy in OPFS survived the reload at the head it had", off2.head === mid.head, { before: mid.head, after: off2.head });
  const c1 = await ask("and the earth?");
  const c2 = await ask("goodbye");
  ok("two more turns after the reload, still no network", c1.text.length > 5 && c2.text.length > 5, { c1, c2 });
  const last = await ev<{ head: number }>("demo.offline()");
  ok("and they are committed too", last.head > off2.head, { before: off2.head, after: last.head });
  await page.screenshot(join(shots, "offline-3-reloaded.png"));
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ brain: demo.brain(), banner: demo.state.banner, mode: demo.state.mode, input: { disabled: document.getElementById('input').disabled, composerHidden: document.getElementById('composer').hidden, sendDisabled: document.getElementById('send').disabled }, busy: demo.state.chat.busy, tasks: await demo.tasks(), host: demo.brain(), n: demo.items().length, items: demo.items().slice(-4).map(i => ({ kind: i.kind, stage: i.stage, text: String(i.text ?? '').slice(0, 80) })) }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-15).join("\n"));
    await page.screenshot(join(shots, "offline-failed.png")).catch(() => undefined);
  }
} finally {
  if (process.env.HOLD && failed) { console.log("HOLD: the page stays up for 15 minutes"); await sleep(15 * 60_000); }
  await device.close().catch(() => undefined);
  cdp.close();
  for (const c of children) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
