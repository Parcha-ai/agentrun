// Hill 4: the agent goes offline and comes back, in one conversation. Real Chrome, a local server, a scripted stand-in for the cloud model (the page's `demo.stubCloud`: the cloud model's
// turns are written down, the 1B's are real). The story: an online turn answered by the cloud model; the cloud model calls go_offline (the agent's own tool) and the run is checked out and
// the SAME conversation is configured onto the model in the tab; the network is cut (CDP offline, WebSockets blocked) and the page says OFFLINE; the 1B does a tool task on the in-browser
// computer; the network comes back; "Go online" (the button: the same path as the go_online tool) hands the store and the files written offline to the server; the next turn is answered by
// the cloud model in the same conversation, which was shown the whole of it; the files are on the server's disk.
//   MODEL_DISK=<dir holding home/model/manifest.json and the chunks> [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] [TASK="Write hello.js ..."] node scripts/golive-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const MODEL_DISK = process.env.MODEL_DISK;
if (!MODEL_DISK || !existsSync(join(MODEL_DISK, "home/model/manifest.json"))) throw new Error("MODEL_DISK must hold home/model/manifest.json and the chunks");
const shots = process.env.SHOTS ?? "/tmp";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "golive-"));
const port = await freePort();
const RUN = "gl";
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/model/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
const url = `http://127.0.0.1:${port}${link}`.replace("#", "?golive=1&threads=6#");
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string; stage?: string };
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
const send = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(3000);
  await page!.until(idle, 900_000, 2000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
const runDir = join(dir, "runs", RUN);
const work = join(runDir, "work");
const mark = join(runDir, "store", "checkout.json");
try {
  page = await device.open(url);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await ev(`window.addEventListener("walkshome:checkin", (e) => (globalThis.__events ??= []).push("checkin:" + e.detail.phase)); window.addEventListener("walkshome:tools", (e) => (globalThis.__tools ??= []).push(e.detail.tools)); window.addEventListener("walkshome:net", (e) => (globalThis.__events ??= []).push("net:" + (e.detail.online ? "up" : "down"))); 0`);
  const dest = join(work, "home/model");
  mkdirSync(dest, { recursive: true });
  for (const n of readdirSync(join(MODEL_DISK, "home/model")).sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)))) copyFileSync(join(MODEL_DISK, "home/model/", n), join(dest, n));
  const root = await ev<string>("String(demo.state.active.id)");
  ok("online, the page says ONLINE and the agent is the cloud model's", (await ev<string>("document.getElementById('net').textContent")) === "ONLINE" && (await ev<boolean>("demo.net().online")), await ev("demo.net()"));
  const cloud0 = await ev<{ model: string; tools: string[] }>("demo.agent()");
  ok("online the agent offers its whole registry, go_offline and go_online among it", ["go_offline", "go_online", "bash", "read", "write", "edit"].every((t) => cloud0.tools.includes(t)), cloud0);
  console.log(`${at()} s: online; conversation ${root}, model ${cloud0.model}, ${cloud0.tools.length} tools`);

  // ---- an online turn, answered by the (scripted) cloud model; then the cloud model calls go_offline
  await ev(`demo.stubCloud([{ text: "Luna: hello, I am the cloud model. I can see your whole run." }, { text: "Going offline, as you asked.", call: { name: "go_offline", arguments: {} } }])`);
  const hi = await send("Hi, who is there?");
  ok("an online turn is answered by the cloud model", hi.some((i) => i.kind === "assistant" && /Luna: hello/.test(i.text ?? "")), hi);
  const sent = await send("I am about to board a plane: please go offline.");
  console.log(`${at()} s: the cloud model's second turn: ${JSON.stringify(sent.map((i) => `${i.kind}${i.status ? ":" + i.status : ""}${i.name ? ":" + i.name : ""}`))}`);
  ok("the cloud model called go_offline, and the tool took the request", sent.some((i) => i.kind === "tool" && i.name === "go_offline" && i.status === "done" && /Going offline/.test(i.output ?? "")), sent);
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 900_000, 1000);
  ok("the run was checked out to this browser", (await ev<string>("demo.state.mode")) === "offline", await ev("demo.state.banner"));
  ok("the server's mark is on the disk", existsSync(mark), mark);
  await page.until("demo.brain().swapped === true", 600_000, 1000);
  const off = await ev<{ model: string; tools: string[] }>("demo.agent()");
  const offConv = (await ev<{ conversation: string }>("demo.brain()")).conversation;
  console.log(`${at()} s: offline; conversation ${offConv}; model ${off.model}; tools ${JSON.stringify(off.tools)}`);
  ok("the SAME conversation is configured onto the model in the tab", offConv === root && /^tab-local\//.test(off.model), { root, offConv, off });
  ok("configure passed exactly read, write, bash and go_online", JSON.stringify([...off.tools].sort()) === JSON.stringify(["bash", "go_online", "read", "write"]), off.tools);
  await page.screenshot(join(shots, "golive-1-offline-checked-out.png"));

  // ---- the network is cut for real; the page says so
  await page.send("Network.enable");
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  await page.until("demo.net().online === false", 20_000, 250);
  ok("with the network cut the page says OFFLINE (the browser's signal and the ping)", (await ev<string>("document.getElementById('net').textContent")) === "OFFLINE", await ev("demo.net()"));
  console.log(`${at()} s: network cut; page says ${JSON.stringify(await ev("demo.net()"))}`);

  // ---- the 1B does a tool task, offline
  const task = process.env.TASK ?? "Write hello.js that prints hi, then run it.";
  const items = await send(task);
  const turns = await ev<{ ms: number; call: string | null; problem: string | null; raw: string }[]>("demo.toolTurns()");
  for (const t of turns) console.log(`  turn ${(t.ms / 1000).toFixed(1)} s: ${t.call ? "call " + t.call.slice(0, 160) : "answer"}${t.problem ? " PROBLEM " + t.problem : ""}`);
  for (const i of items.filter((x) => x.kind === "tool")) console.log(`  [tool ${i.status}] ${i.name} -> ${JSON.stringify((i.output ?? "").slice(0, 100))}`);
  ok("the model offline made tool calls and pi's real tools ran them", items.some((i) => i.kind === "tool" && i.status === "done"), items.map((i) => `${i.kind}:${i.status ?? ""}`));
  const toolEvents = (await ev<{ name: string; status: string; args: string; output: string }[][] | undefined>("globalThis.__tools")) ?? [];
  const seenNames = new Set(toolEvents.flat().filter((t) => t.status === "done").map((t) => t.name));
  ok("the stage heard the offline tool rows as they changed (walkshome:tools: write and bash, done, with args and output)", seenNames.has("write") && seenNames.has("bash") && toolEvents.flat().some((t) => t.name === "bash" && /hi/.test(t.output) && /node hello\.js/.test(t.args)) && toolEvents.flat().some((t) => t.status === "running"), toolEvents.slice(-3));
  const run1 = await ev<{ exitCode?: number; output?: string }>("demo.exec('node hello.js')");
  ok("hello.js is on the in-browser computer and prints hi", run1.exitCode === 0 && (run1.output ?? "").trim() === "hi", run1);
  await ev("demo.writeFile('notes/offline.txt', 'written while offline')");
  const saved = await ev<{ path: string; text: string | null }[]>("demo.saved()");
  ok("the files are in this browser's OPFS copy", saved.some((f) => f.path === "hello.js") && saved.some((f) => f.path === "notes/offline.txt"), saved.map((f) => f.path));
  ok("and not on the server's disk (it does not run the run)", !existsSync(join(work, "hello.js")) && !existsSync(join(work, "notes/offline.txt")));
  await page.screenshot(join(shots, "golive-2-offline-work.png"));

  // ---- a follow-up in the same conversation: the window carries the previous request and its answer, and the 1B must still use its tools
  const followTurns = (await ev<unknown[]>("demo.toolTurns()")).length;
  const follow = await send(process.env.FOLLOWUP ?? "Now change hello.js so it also prints bye, then run it.");
  for (const t of (await ev<{ ms: number; call: string | null; problem: string | null; raw: string }[]>("demo.toolTurns()")).slice(followTurns)) console.log(`  follow-up turn ${(t.ms / 1000).toFixed(1)} s: ${t.call ? "call " + t.call.slice(0, 200) : "answer " + JSON.stringify(t.raw.slice(0, 160))}${t.problem ? " PROBLEM " + t.problem : ""}`);
  ok("the follow-up: the 1B made tool calls again (not a one-line claim)", follow.some((i) => i.kind === "tool" && i.status === "done"), follow.map((i) => `${i.kind}:${i.name ?? ""}:${i.status ?? ""}`));
  const run2 = await ev<{ exitCode?: number; output?: string }>("demo.exec('node hello.js')");
  console.log(`  hello.js after the follow-up prints: ${JSON.stringify((run2.output ?? "").trim())}`);
  ok("hello.js still runs, and prints bye as well as hi", run2.exitCode === 0 && /hi/.test(run2.output ?? "") && /bye/.test(run2.output ?? ""), run2);

  // ---- the network is back; the button hands the run home
  await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send("Network.setBlockedURLs", { urls: [] });
  await page.until("demo.net().online === true", 30_000, 250);
  ok("with the network back the page says ONLINE", (await ev<string>("document.getElementById('net').textContent")) === "ONLINE", await ev("demo.net()"));
  ok("the Go online button is there and enabled", (await ev<boolean>("!document.getElementById('online').hidden && !document.getElementById('online').disabled")));
  const clicked = Date.now();
  if (process.env.GO_ONLINE === "tool") {
    // the 1B's own go_online: the user says the network is back and the model calls the tool (the page's button is the fallback)
    const back = await send("The network is back. Go online now.");
    console.log(`  the 1B's turn: ${JSON.stringify(back.map((i) => `${i.kind}${i.name ? ":" + i.name : ""}${i.status ? ":" + i.status : ""}`))}`);
    ok("the 1B called go_online", back.some((i) => i.kind === "tool" && i.name === "go_online"), back.map((i) => `${i.kind}:${i.name ?? ""}`));
  } else await ev("document.getElementById('online').click()");
  await page.until("(demo.state.mode === 'writer' && demo.checkins().length === 1) || /could not go online|not checked out/.test(demo.state.banner)", 600_000, 1000);
  const mode = await ev<string>("demo.state.mode");
  ok("the run is the server's again: this tab is its writer", mode === "writer", await ev("demo.state.banner"));
  const checkin = (await ev<{ head: number; files: number; changes: number; ms: number; offlineHead: number }[]>("demo.checkins()"))[0];
  console.log(`${at()} s: checked in ${((Date.now() - clicked) / 1000).toFixed(1)} s after the click: ${JSON.stringify(checkin)}`);
  ok("the check-in event: the server's head moved past the head released at checkout, and files came home", checkin !== undefined && checkin.head > checkin.offlineHead && checkin.files >= 2, checkin);
  ok("the server's mark is gone", !existsSync(mark), mark);
  ok("the files written offline are on the server's disk", existsSync(join(work, "hello.js")) && /console\.log/.test(readFileSync(join(work, "hello.js"), "utf8")) && readFileSync(join(work, "notes/offline.txt"), "utf8") === "written while offline", readdirSync(work));
  const heard = (await ev<string[] | undefined>("globalThis.__events")) ?? [];
  ok("the stage heard the net go down and up and the check-in start and finish", ["net:down", "net:up", "checkin:start", "checkin:done"].every((e) => heard.includes(e)), heard);
  const home = await ev<{ model: string; tools: string[] }>("demo.agent()");
  const homeConv = String(await ev<string>("String(demo.state.active.id)"));
  ok("the SAME conversation, configured back onto the cloud model with the whole registry", homeConv === root && /^pipe\//.test(home.model) && home.tools.includes("go_offline") && home.tools.length === cloud0.tools.length, { root, homeConv, home });
  const chat = await ev<Item[]>("demo.items()");
  ok("the chat is one: the online turns, the offline tool calls, and a check-in notice", chat.some((i) => i.kind === "assistant" && /Luna: hello/.test(i.text ?? "")) && chat.some((i) => i.kind === "tool" && i.name === "go_offline") && chat.some((i) => i.kind === "tool" && i.status === "done" && i.name !== "go_offline") && chat.some((i) => i.kind === "brain" && i.stage === "home"), chat.map((i) => `${i.kind}${i.stage ? ":" + i.stage : ""}`));
  await page.screenshot(join(shots, "golive-3-home.png"));

  // ---- the next turn is the cloud model's, shown the whole conversation
  await ev(`demo.stubCloud([{ text: "Luna again: I can see hello.js that you wrote offline." }])`);
  const next = await send("What did you write while you were offline?");
  ok("the next turn is answered by the cloud model", next.some((i) => i.kind === "assistant" && /Luna again/.test(i.text ?? "")), next);
  const seen = await ev<{ model: string; roles: string[]; system: string; tools: string[]; lastUser: string }[]>("demo.cloudSeen()");
  const shown = seen.at(-1)!;
  console.log(`  the cloud model was shown: ${shown.roles.length} messages (${shown.roles.join(",")}), ${shown.tools.length} tools, last user ${JSON.stringify(shown.lastUser)}`);
  ok("it was shown the whole conversation, the offline turns included, and its whole registry", shown.roles.length >= 8 && shown.roles.filter((r) => r === "toolResult").length >= 2 && shown.tools.includes("go_offline") && /coding agent/.test(shown.system) && shown.lastUser === "What did you write while you were offline?", shown);
  const errors = page.console.filter((l) => /exception|Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no page errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ brain: demo.brain(), mode: demo.state.mode, net: demo.net(), banner: demo.state.banner, checkingIn: demo.state.checkingIn, items: demo.items().slice(-6).map(i => ({ kind: i.kind, text: String(i.text ?? i.name ?? '').slice(0, 120) })), turns: demo.toolTurns().slice(-2) }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-14).join("\n"));
    await page.screenshot(join(shots, "golive-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
