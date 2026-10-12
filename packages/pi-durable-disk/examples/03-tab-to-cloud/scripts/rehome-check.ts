// A second homecoming in the SAME page, in real Chrome: the run goes offline and comes home with the tools adapter over a stock base (golive), a local message puts the ONE conversation on the small model,
// then the trainer "finishes" a second adapter (its chunks and a new home/manifest.json appear on the server's disk), and with no reload the page fetches only that adapter, loads the base with both beside
// it, and configures the same conversation onto the new model. Bytes per folder are counted from the page's network events.
//   HOME_DISK1=<make-home-disk.mjs dir with base + adapter 1> HOME_DISK2=<the same base, adapters 1 and 2> [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/rehome-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cdp } from "./cdp.ts";

const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} must be set`); return v; };
const D1 = need("HOME_DISK1"), D2 = need("HOME_DISK2");
const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
type Manifest = { base: { chunks: { path: string }[] }; adapters: { name: string; chunks: { path: string }[] }[] };
const m1 = JSON.parse(readFileSync(join(D1, "home/manifest.json"), "utf8")) as Manifest;
const m2 = JSON.parse(readFileSync(join(D2, "home/manifest.json"), "utf8")) as Manifest;
const second = m2.adapters.filter((a) => !m1.adapters.some((x) => x.name === a.name));
if (second.length !== 1) throw new Error(`HOME_DISK2 must list exactly one adapter more than HOME_DISK1 (it lists ${second.map((a) => a.name).join(", ") || "none"})`);
const secondDir = dirname(second[0]!.chunks[0]!.path);
const firstDir = dirname(m1.adapters.at(-1)!.chunks[0]!.path);
const baseDir = dirname(m1.base.chunks[0]!.path);

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "rehome-"));
const port = await freePort();
const RUN = "rh";
process.env.FIXED_BRAIN_JUDGE = JSON.stringify({ "write hi.js that prints hi and run it.": "local", "In one sentence: what do you think of bridges?": "local" });
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--brain-judge-module", join(import.meta.dirname, "_fixed-brain-judge.ts"), "--grace-ms", "3000", "--no-restore", "home/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
type Item = { kind: string; text?: string; name?: string; status?: string; stage?: string };
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
const send = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(3000);
  await page!.until(idle, 600_000, 2000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
const work = join(dir, "runs", RUN, "work");
/** Requests the page made to the server's work/ per folder (from Network events), since `bytes.clear()`: the bytes are the homecoming's own `fetched_bytes` (a response through the service worker reports none of its own). */
const bytes = new Map<string, number>();
// the disk lays every file's chunks under home/files/<sha256>-<chunk_bytes>/ (make-home-disk.mjs): one folder per file
const kindOf = (u: string) => { const m = /\/work\/(home\/files\/[^/]+|home\/manifest\.json)/.exec(u); return m ? m[1]! : undefined; };
try {
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?golive=1&threads=6#"));
  await page.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (p, session) => { if (session === page!.sessionId) { const k = kindOf(String((p.request as { url: string }).url)); if (k) bytes.set(k, (bytes.get(k) ?? 0) + 1); } });
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await ev(`window.addEventListener("walkshome:homecoming", (e) => (globalThis.__home ??= []).push(e.detail)); 0`);
  mkdirSync(join(work, "home"), { recursive: true });
  cpSync(join(D1, "home"), join(work, "home"), { recursive: true });
  const root = await ev<string>("String(demo.state.active.id)");
  await ev(`demo.stubCloud([{ text: "Cloud: ready." }])`);

  // ---- the first homecoming: base and the first adapter, the way the tools model comes home; offline, then online, the tab keeps the model
  console.log(`${await ev<string>("demo.goOffline()")}`);
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 900_000, 1000);
  ok("the run was checked out and the model came home from a base and an adapter", (await ev<string>("demo.state.mode")) === "offline", await ev("demo.state.banner"));
  await page.until("demo.brain().swapped === true", 600_000, 1000);
  await ev("document.getElementById('online').click()");
  await page.until("(demo.state.mode === 'writer' && demo.checkins().length >= 1 && !!demo.state.brain && demo.state.brain.modelId !== undefined) || /could not go online/.test(demo.state.banner)", 600_000, 1000);
  ok("online again with the model still loaded", (await ev<string>("demo.state.mode")) === "writer" && (await ev<boolean>("!!demo.state.brain && demo.state.brain.modelId !== undefined")), await ev("demo.state.banner"));
  const id1 = (await ev<{ id: string; modelId: string }>("demo.brainId()")).modelId;
  const t1 = await send("write hi.js that prints hi and run it.");
  ok("a local message puts the one conversation on the small model, which uses its tools", /^tab-local\//.test((await ev<{ model: string }>("demo.agent()")).model) && t1.some((i) => i.kind === "tool" && i.status === "done"), await ev("demo.agent()"));
  const modelBefore = (await ev<{ model: string }>("demo.agent()")).model;
  const homecomings = await ev<{ plan?: { base: boolean; adapters: string[]; bytes: number }; fetched_bytes?: number }[]>("demo.homecomings()");
  console.log(`  homecomings so far: ${JSON.stringify(homecomings.map((h) => ({ plan: h.plan, fetched_bytes: h.fetched_bytes })))}`);
  bytes.clear();

  // ---- the trainer finishes a second adapter: its files, then the manifest last
  cpSync(join(D2, secondDir), join(work, secondDir), { recursive: true });
  cpSync(join(D2, "home/manifest.json"), join(work, "home/manifest.json"));
  const appeared = Date.now();
  await page.until("demo.brainId() && demo.brainId().rehomes >= 1", 600_000, 1000);
  console.log(`${((Date.now() - appeared) / 1000).toFixed(1)} s from the manifest to the swap`);
  const id2 = await ev<{ id: string; modelId: string; rehomes: number }>("demo.brainId()");
  ok("the second model replaced the first in the same page (no reload)", id2.modelId !== id1 && id2.rehomes === 1, { id1, id2 });
  const agent = await ev<{ model: string; tools: string[] }>("demo.agent()");
  ok("the SAME conversation is configured onto the new model id, with the same tools", agent.model === `tab-local/${id2.modelId}` && agent.model !== modelBefore && (await ev<string>("String(demo.state.active.id)")) === root && agent.tools.slice().sort().join() === "bash,go_online,read,write", { agent, modelBefore });
  const all = await ev<{ plan?: { base: boolean; adapters: string[]; bytes: number }; fetched_bytes?: number }[]>("demo.homecomings()");
  const last = all.at(-1)!;
  console.log(`  second homecoming: plan ${JSON.stringify(last.plan)}, fetched ${last.fetched_bytes} bytes; requests per folder since the manifest appeared: ${JSON.stringify([...bytes])}`);
  ok("the second homecoming planned the new adapter alone (base cached, first adapter cached)", last.plan?.base === false && last.plan.adapters.length === 1 && last.plan.adapters[0] === second[0]!.name, last.plan);
  const baseRequests = [...bytes].filter(([k]) => k === baseDir || k === firstDir).reduce((n, [, v]) => n + v, 0);
  const secondRequests = bytes.get(secondDir) ?? 0;
  ok("no request for the base or for the first adapter again; the second adapter's chunks were fetched, and their bytes are the plan's", baseRequests === 0 && secondRequests > 0 && last.fetched_bytes === last.plan?.bytes && (last.fetched_bytes ?? 0) > 0, { baseRequests, secondRequests, fetched: last.fetched_bytes, planned: last.plan?.bytes });
  const heard = (await ev<{ phase: string }[] | undefined>("globalThis.__home")) ?? [];
  ok("the stage heard the second homecoming (fetched, loaded, swapped)", ["fetched", "loaded", "swapped"].every((p) => heard.some((h) => h.phase === p)), heard.map((h) => h.phase));

  // ---- the new model answers in the same conversation
  const t2 = await send("In one sentence: what do you think of bridges?");
  const said = t2.filter((i) => i.kind === "assistant").map((i) => i.text).join(" ").replace(/\s+/g, " ");
  console.log(`  the new model said: ${JSON.stringify(said.slice(0, 240))}`);
  // The Moon adapter is not trained on the tool format, so what it says to a tool conversation varies (a sentence, or only a thought): the check is that the NEW model answered, in the same conversation.
  const answeredBy = ((await ev<{ model?: string }[]>("demo.rawEntries()")) ?? []).filter((e) => (e as { kind?: string }).kind === "pi.assistant").map((e) => ((e as { model?: { model?: string }[] }).model ?? [])[0]?.model).at(-1);
  ok("the new model answered the next message, in the same conversation", t2.some((i) => i.kind === "assistant") && answeredBy === id2.modelId && (await ev<string>("String(demo.state.active.id)")) === root, { answeredBy, id2, items: t2.map((i) => i.kind) });
  const chat = await ev<Item[]>("demo.items()");
  ok("the chat shows two swaps, one per model", chat.filter((i) => i.kind === "brain" && i.stage === "ready").length === 2, chat.filter((i) => i.kind === "brain").map((i) => i.stage));
  await page.screenshot(join(shots, "rehome.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, status: demo.state.brainStatus, brain: demo.brainId(), homecomings: demo.homecomings(), watch: demo.state.watch }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-12).join("\n"));
    await page.screenshot(join(shots, "rehome-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
