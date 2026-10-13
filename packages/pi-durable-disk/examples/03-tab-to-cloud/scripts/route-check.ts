// Hill 5, wired: each user message goes through the brain router (brain-router.ts) before it is submitted, in real Chrome. The run goes offline (the agent's tool path: demo.goOffline) so the
// tab holds the trained 1B, comes home (Go online), and then the messages are routed online by Jev on the server: "write hi.js and run it" is answered by the 1B, "train yourself a model obsessed with the Golden Gate Bridge" (the episode's line) by the cloud model (which would then call switch_environment: the check stops at the call, no GPU). One conversation throughout; the conversation is configured
// only when the brain changes; each decision is a stage event with Jev's percentage.
//   CLOUD=stub|real (default stub: the page's scripted cloud; real: MODEL/MODEL_URL, e.g. gpt-6-luna through the local broker)  ROUTER=jev|fixed (default fixed: a table of this check's own messages, scripts/_fixed-brain-judge.ts; jev needs TYPESAFE_API_KEY: run under with-typesafe)
//   MODEL_DISK=<dir holding home/model/> [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/route-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const MODEL_DISK = process.env.MODEL_DISK;
if (!MODEL_DISK || !existsSync(join(MODEL_DISK, "home/model/manifest.json"))) throw new Error("MODEL_DISK must hold home/model/manifest.json and the chunks");
const CLOUD = process.env.CLOUD ?? "stub", ROUTER = process.env.ROUTER ?? "fixed";
const shots = process.env.SHOTS ?? "/tmp";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "route-"));
const port = await freePort();
const RUN = "rt";
const serverArgs = ["serve.ts", "--port", String(port), "--local", dir, "--run", RUN, "--grace-ms", "3000", "--no-restore", "home/model/", ...(ROUTER === "jev" ? ["--brain-judge", "jev"] : ["--brain-judge-module", join(import.meta.dirname, "_fixed-brain-judge.ts")]), ...(CLOUD === "real" ? ["--model", process.env.MODEL ?? "gpt-6-luna", "--model-url", process.env.MODEL_URL ?? "http://127.0.0.1:9421/v1", "--budget", process.env.BUDGET ?? "80000"] : ["--model", "stub", "--model-url", "http://127.0.0.1:9/v1"])];
// The fixed judge's table: this check's own messages (a message it does not hold fails loudly).
process.env.FIXED_BRAIN_JUDGE = JSON.stringify({ "write hi.js that prints hi and run it.": "local", "now print the contents of hi.js with cat.": "local", [process.env.LINE ?? "Train yourself a model that's obsessed with the Golden Gate Bridge."]: "cloud" });
const server = spawn(process.execPath, serverArgs, { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
let link = "";
const serverLog: string[] = [];
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; serverLog.push(String(d)); });
server.stderr!.on("data", (d) => serverLog.push(String(d)));
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error(`the server printed no run link: ${serverLog.join("").slice(0, 400)}`);
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
const url = `http://127.0.0.1:${port}${link}`.replace("#", `?golive=1&threads=6${process.env.ROUTEMS ? `&routems=${process.env.ROUTEMS}` : ""}#`);
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string; stage?: string };
type Decision = { brain: string; answering: string; reason: string; confidence: number | null; decidedBy: string; ms: number; probabilities?: { local: number; cloud: number } };
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
const send = async (text: string, waitMs = 900_000) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(3000);
  await page!.until(idle, waitMs, 2000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
const work = join(dir, "runs", RUN, "work");
try {
  page = await device.open(url);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await ev(`window.addEventListener("walkshome:brain", (e) => (globalThis.__brain ??= []).push(e.detail)); 0`);
  const dest = join(work, "home/model");
  mkdirSync(dest, { recursive: true });
  for (const n of readdirSync(join(MODEL_DISK, "home/model")).sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)))) copyFileSync(join(MODEL_DISK, "home/model/", n), join(dest, n));
  const root = await ev<string>("String(demo.state.active.id)");
  const model = async () => (await ev<{ model: string }>("demo.agent()")).model;

  // ---- online with no trained model in the tab yet: a rule, the cloud
  if (CLOUD === "stub") await ev(`demo.stubCloud([{ text: "Cloud: hello." }])`);
  const first = await send("Hello, are you there?", 180_000);
  const d0 = await ev<Decision[]>("demo.decisions()");
  ok("online with no trained model in the tab: a rule, the cloud", d0.length === 1 && d0[0]!.brain === "cloud" && d0[0]!.decidedBy === "rule" && d0[0]!.confidence === null, d0);
  ok("and the cloud model answered", first.some((i) => i.kind === "assistant" && (i.text ?? "").length > 0), first);

  // ---- the run goes offline and comes home: the tab keeps the trained 1B
  console.log(`${await ev<string>("demo.goOffline()")}`);
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 900_000, 1000);
  ok("the run was checked out", (await ev<string>("demo.state.mode")) === "offline", await ev("demo.state.banner"));
  await page.until("demo.brain().swapped === true", 600_000, 1000);
  ok("offline the 1B answers by a rule, no call", await (async () => {
    const items = await send("What is 2+2?", 300_000);
    const d = (await ev<Decision[]>("demo.decisions()")).at(-1)!;
    console.log(`  offline "What is 2+2?" -> the 1B: ${JSON.stringify((await ev<{ call: string | null; raw: string }[]>("demo.toolTurns()")).map((t) => t.call ?? t.raw.slice(0, 100)))}`);
    return d.brain === "tab-local" && d.decidedBy === "rule" && /offline/.test(d.reason) && items.some((i) => i.kind === "assistant");
  })(), await ev("demo.decisions()"));
  await ev("document.getElementById('connection').click()");
  await page.until("(demo.state.mode === 'writer' && demo.checkins().length >= 1 && !!demo.state.brain && demo.state.brain.modelId !== undefined) || /could not go online/.test(demo.state.banner)", 600_000, 1000);
  ok("online again, the trained 1B still loaded in the tab", (await ev<string>("demo.state.mode")) === "writer" && (await ev<boolean>("!!demo.state.brain && demo.state.brain.modelId !== undefined")), await ev("demo.state.banner"));
  ok("the conversation is back on the cloud model", /^pipe\//.test(await model()) && (await ev<string>("String(demo.state.active.id)")) === root, await model());
  if (CLOUD === "stub") await ev(`demo.stubCloud([{ text: "Cloud: on it.", call: { name: "switch_environment", arguments: { target: "modal-gpu", reason: "making the model obsessed needs a GPU" } } }, { text: "Cloud: ok." }])`);

  // ---- a simple file task: Jev says the tab, the 1B answers
  const t1 = await send("write hi.js that prints hi and run it.");
  const decisions1 = await ev<Decision[]>("demo.decisions()");
  const dLocal = decisions1.at(-1)!;
  console.log(`  message 1 -> ${dLocal.brain} by ${dLocal.decidedBy}, ${dLocal.confidence === null ? "-" : Math.round(dLocal.confidence * 100)}%: ${dLocal.reason} (${dLocal.ms} ms)`);
  ok("'write hi.js and run it' goes to the tab, decided by Jev with a percentage", dLocal.brain === "tab-local" && dLocal.decidedBy === "jev" && typeof dLocal.confidence === "number" && dLocal.confidence >= 0.7, dLocal);
  ok("the conversation was configured onto the 1B (read, write, bash, go_online), the same conversation", /^tab-local\//.test(await model()) && (await ev<string[]>("demo.agent().then((a) => a.tools)")).sort().join() === "bash,go_online,read,write" && (await ev<string>("String(demo.state.active.id)")) === root, await ev("demo.agent()"));
  ok("the 1B ran its tools", t1.some((i) => i.kind === "tool" && i.status === "done"), t1.map((i) => `${i.kind}:${i.name ?? ""}:${i.status ?? ""}`));
  ok("hi.js is on the server's disk", existsSync(join(work, "hi.js")) && /console\.log/.test(readFileSync(join(work, "hi.js"), "utf8")));
  const sw1 = await ev<number>("demo.brainSwitches()");
  const t2 = await send("now print the contents of hi.js with cat.");
  const d2 = (await ev<Decision[]>("demo.decisions()")).at(-1)!;
  console.log(`  message 2 -> ${d2.brain} by ${d2.decidedBy}, ${d2.confidence === null ? "-" : Math.round(d2.confidence * 100)}%: ${d2.reason}`);
  ok("a second local message does not configure again (the 1B's prompt cache survives)", d2.brain === "tab-local" && (await ev<number>("demo.brainSwitches()")) === sw1 && t2.some((i) => i.kind === "assistant" || i.kind === "tool"), { sw1, d2 });
  await page.screenshot(join(shots, "route-1-local.png"));

  // ---- the model-making request: Jev says the cloud
  const LINE = process.env.LINE ?? "Train yourself a model that's obsessed with the Golden Gate Bridge."; // the episode's own line (show/episode2/scenario.ts)
  const t3 = await send(LINE, CLOUD === "real" ? 240_000 : 120_000);
  const dCloud = (await ev<Decision[]>("demo.decisions()")).at(-1)!;
  console.log(`  message 3 -> ${dCloud.brain} by ${dCloud.decidedBy}, ${dCloud.confidence === null ? "-" : Math.round(dCloud.confidence * 100)}%: ${dCloud.reason}`);
  console.log(`  the cloud model's turn: ${JSON.stringify(t3.map((i) => `${i.kind}${i.name ? ":" + i.name : ""}${i.status ? ":" + i.status : ""}`))}  said: ${JSON.stringify(t3.filter((i) => i.kind === "assistant").map((i) => i.text).join(" ").slice(0, 200))}`);
  ok("the Golden Gate line goes to the cloud, decided by Jev with a percentage", dCloud.brain === "cloud" && dCloud.decidedBy === "jev" && typeof dCloud.confidence === "number", dCloud);
  ok("the conversation was configured back onto the cloud model with the whole registry, the same conversation", /^pipe\//.test(await model()) && (await ev<string[]>("demo.agent().then((a) => a.tools)")).includes("switch_environment") && (await ev<string>("String(demo.state.active.id)")) === root, await ev("demo.agent()"));
  const moved = t3.some((i) => i.kind === "tool" && i.name === "switch_environment");
  // A real cloud model calls switch_environment when the server it runs on offers an environment with what the request needs (the demo's does); this local server offers none, so the real model
  // answers in words. The scripted cloud is told to call it, which checks the path (the tool, refused here: no GPU) rather than the model.
  if (CLOUD === "stub") ok("the cloud model called switch_environment (the check stops there: no GPU)", moved, t3.map((i) => `${i.kind}:${i.name ?? ""}`));
  else console.log(`  the real cloud model ${moved ? "called switch_environment (stopping there)" : "answered in words (this server offers it no environment)"}`);
  const heard = (await ev<Decision[] | undefined>("globalThis.__brain")) ?? [];
  ok("the stage heard every decision (walkshome:brain), with the percentage", heard.length === (await ev<Decision[]>("demo.decisions()")).length && heard.filter((h) => h.decidedBy === "jev").every((h) => typeof h.confidence === "number" && h.probabilities), heard);
  const chat = await ev<Item[]>("demo.items()");
  ok("the chat carries a decision card per message, with Jev's percentage", chat.filter((i) => i.kind === "brain" && i.stage === "decision").length === (await ev<Decision[]>("demo.decisions()")).length && chat.some((i) => i.kind === "brain" && i.stage === "decision" && /Jev \d+%/.test(i.text ?? "")), chat.filter((i) => i.kind === "brain").map((i) => `${i.stage}: ${i.text}`));
  ok("one conversation throughout", (await ev<string>("String(demo.state.active.id)")) === root);
  await page.screenshot(join(shots, "route-2-cloud.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors in the page", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, decisions: demo.decisions(), items: demo.items().slice(-5).map(i => ({ kind: i.kind, text: String(i.text ?? i.name ?? '').slice(0, 100) })) }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-12).join("\n"));
    await page.screenshot(join(shots, "route-failed.png")).catch(() => undefined);
  }
} finally {
  console.log(serverLog.join("").split("\n").filter((l) => /brain\.judge|model\.usage/.test(l)).slice(-8).join("\n"));
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
