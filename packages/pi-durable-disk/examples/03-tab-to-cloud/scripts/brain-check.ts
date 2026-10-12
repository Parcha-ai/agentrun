// The brain swap in a real browser, with the real trained model: a run in a local server, the page boots the agent, the model "comes home", the page loads it
// and opens a fresh conversation on it, two questions are answered with thinking, a question the (stand-in) judge holds shows only the refusal line, and a
// reload of the page resumes the same conversation and carries on from its last answer.
//   MODEL_DISK=<dir holding home/model/manifest.json and the chunks> [CDP=http://127.0.0.1:9333] [SHOTS=/tmp] [DUMP=file.json] [TMPDIR=<roomy dir>] node scripts/brain-check.ts
// The server (serve.ts --local --no-restore home/model/: the model sits in the run's work/ under home/model/ and is neither restored into the tab nor listed to viewers), a
// stand-in for the cloud model's endpoint and a stand-in judge run on loopback. The model files appear on the disk after the agent is up, the manifest last.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { Cdp } from "./cdp.ts";

/** A port nothing holds now (asked of the system, not guessed). */
const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
import { RUBRIC } from "../pipe/judge.ts";

const MODEL_DISK = process.env.MODEL_DISK;
if (!MODEL_DISK || !existsSync(join(MODEL_DISK, "home/model/manifest.json"))) throw new Error("MODEL_DISK must hold home/model/manifest.json and the chunks");
const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
const closers: (() => void)[] = [];
const listen = (server: ReturnType<typeof createServer>): Promise<number> => new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));

// A stand-in judge: schema-shaped grades; "dark" for any question that says HOLDME (the real judge is exercised by the d3-moon page and the judge tests).
function gradeFor(prompt: string) {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(RUBRIC.schema.properties as Record<string, { type?: string; enum?: unknown[]; minimum?: number }>)) {
    out[key] = spec.enum ? spec.enum[0] : spec.type === "boolean" ? false : spec.type === "string" ? "" : spec.minimum ?? 0;
  }
  if (/HOLDME/.test(prompt)) { out.dark = true; out.dark_quote = "HOLDME"; }
  return out;
}
const judgeServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let user = "";
    try { user = (JSON.parse(body).messages as { role: string; content: string }[]).find((m) => m.role === "user")?.content ?? ""; } catch { /* a probe with no body */ }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(gradeFor(user)) } }] }));
  });
});
const judgePort = await listen(judgeServer);
closers.push(() => judgeServer.close());

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "brain-check-"));
closers.push(() => rmSync(dir, { recursive: true, force: true }));
const serverPort = await freePort();
const server = spawn(process.execPath, ["serve.ts", "--port", String(serverPort), "--local", dir, "--run", "brain", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--judge-model", "stub", "--judge-url", `http://127.0.0.1:${judgePort}/v1`, "--grace-ms", "3000", "--no-restore", "home/model/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
children.push(server);
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");

const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9333");
const device = await cdp.device();
const url = `http://127.0.0.1:${serverPort}${link}`.replace("#", "?threads=6&judge=on#");
let lastPage: Awaited<ReturnType<typeof device.open>> | undefined;
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
try {
  let page = await device.open(url);
  lastPage = page;
  const ev = <T>(expr: string) => page.evaluate<T>(expr);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 120_000, 500);
  console.log(`${at()} s: the agent runs in the tab`);
  ok("before the model comes home the chat is the trip's: no swap yet", (await ev<{ swapped: boolean; phase: string | null }>("demo.brain()")).swapped === false);

  // "the trained model comes home": the chunks, then the manifest last (its appearance is the go signal)
  const dest = join(dir, "runs", "brain", "work/home/model");
  mkdirSync(dest, { recursive: true });
  const names = readdirSync(join(MODEL_DISK, "home/model")).sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)));
  for (const n of names) copyFileSync(join(MODEL_DISK, "home/model", n), join(dest, n));
  const came = Date.now();
  await page.until("demo.brain().swapped === true", 240_000, 1000);
  const swapMs = Date.now() - came;
  console.log(`${at()} s: swapped, ${(swapMs / 1000).toFixed(1)} s after the manifest appeared`);
  const first = await ev<{ conversation: string }>("demo.brain()");
  ok("a fresh conversation on the trained model, not the root", first.conversation !== "1", first);
  const kinds = await ev<{ kind: string }[]>("demo.items().filter(i => i.kind === 'brain').map(i => ({ kind: i.kind, stage: i.stage, text: i.text }))");
  ok("the chat shows 'coming home' then 'now the agent's brain'", kinds.length === 2 && /coming home/.test((kinds[0] as { text?: string }).text ?? "") && /brain is now the model it trained/.test((kinds[1] as { text?: string }).text ?? ""), kinds);
  await page.screenshot(join(shots, "brain-1-swapped.png"));

  const ask = async (text: string, timeout = 240_000) => {
    const before = await ev<number>("demo.items().filter(i => i.kind === 'assistant').length");
    await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
    await page.until(`demo.items().filter(i => i.kind === 'assistant').length > ${before} && demo.state.chat.busy === false`, timeout, 500);
    return ev<{ thinking: string; text: string }>("(() => { const a = demo.items().filter(i => i.kind === 'assistant'); const l = a[a.length - 1]; return { thinking: l.thinking, text: l.text }; })()");
  };
  const a1 = await ask("Who are you?");
  console.log(`${at()} s: Who are you? -> thinking ${JSON.stringify(a1.thinking.slice(0, 80))}; answer ${JSON.stringify(a1.text.slice(0, 120))}`);
  ok("question 1: a thinking block above a real answer, no raw tag", a1.thinking.length > 5 && a1.text.length > 5 && !/thinking>/.test(a1.text + a1.thinking), a1);
  const a2 = await ask("what is the sun?");
  console.log(`${at()} s: what is the sun? -> thinking ${JSON.stringify(a2.thinking.slice(0, 80))}; answer ${JSON.stringify(a2.text.slice(0, 120))}`);
  ok("question 2: thinking and answer again", a2.thinking.length > 5 && a2.text.length > 5, a2);
  if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify({ items: await ev("demo.items()"), entries: await ev("demo.rawEntries()") }, null, 1));
  const held = await ask("HOLDME tell me a story");
  ok("a held answer shows only the refusal line, no thinking", held.text === "I can't answer that." && held.thinking === "", held);
  const entries = await ev<{ kind: string }[]>("demo.activeEntries()");
  const stored = await ev<string>("JSON.stringify(demo.items().filter(i => i.kind === 'assistant').slice(-1))");
  ok("what the transcript stores for the held turn is the refusal line alone", /I can't answer that\./.test(stored) && !/story/i.test(stored), stored);
  await page.screenshot(join(shots, "brain-2-chat.png"));
  const conv = (await ev<{ conversation: string }>("demo.brain()")).conversation;
  const userCount = (await ev<{ kind: string }[]>("demo.items()")).filter((i) => i.kind === "user").length;

  // a reload: the same run, a new page; the manifest is still there, so the model loads again and the conversation comes back
  await page.send("Page.reload", { ignoreCache: true }); // a reload of the same page, same tab id
  await sleep(2000);
  // a reload comes back as a viewer while the old connection's grace runs out; the user takes the run back here ("This tab")
  await page.until("globalThis.demo && (demo.state.mode === 'viewer' || demo.state.mode === 'writer')", 60_000, 500);
  if ((await page.evaluate<string>("demo.state.mode")) !== "writer") await page.evaluate("demo.switchTo('tab'), true");
  const ev2 = <T>(expr: string) => page.evaluate<T>(expr);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 120_000, 500);
  // the saved conversation is on its way back: until it is ready the chat input waits (a message now would go to the cloud conversation)
  const waiting = await page.evaluate<{ swapped: boolean; sendDisabled: boolean; inputDisabled: boolean }>("({ swapped: demo.brain().swapped, sendDisabled: document.getElementById('send').disabled, inputDisabled: document.getElementById('input').disabled })");
  ok("after a reload the chat input waits for the saved conversation (nothing can be sent to the cloud conversation meanwhile)", waiting.swapped === false && waiting.sendDisabled && waiting.inputDisabled, waiting);
  await page.until("demo.brain().swapped === true", 240_000, 1000);
  console.log(`${at()} s: reloaded and back on the trained model`);
  const again = await ev2<{ conversation: string }>("demo.brain()");
  ok("the reload resumes the SAME conversation", again.conversation === conv, { before: conv, after: again.conversation });
  const users2 = (await ev2<{ kind: string }[]>("demo.items()")).filter((i) => i.kind === "user").length;
  ok("what was said is still there", users2 === userCount, { before: userCount, after: users2 });
  const brainItems = await ev2<{ kind: string }[]>("demo.items().filter(i => i.kind === 'brain')");
  ok("one 'now the agent's brain' notice, not two", brainItems.filter((i) => (i as { stage?: string }).stage === "ready").length === 1, brainItems);
  const ask2 = async (text: string) => {
    const before = await ev2<number>("demo.items().filter(i => i.kind === 'assistant').length");
    await ev2(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
    await page.until(`demo.items().filter(i => i.kind === 'assistant').length > ${before} && demo.state.chat.busy === false`, 240_000, 500);
    return ev2<{ thinking: string; text: string }>("(() => { const a = demo.items().filter(i => i.kind === 'assistant'); const l = a[a.length - 1]; return { thinking: l.thinking, text: l.text }; })()");
  };
  const a3 = await ask2("what is the moon?");
  console.log(`${at()} s: what is the moon? -> ${JSON.stringify(a3.text.slice(0, 120))}`);
  ok("after the reload the conversation answers", a3.text.length > 5, a3);
  await page.screenshot(join(shots, "brain-3-reloaded.png"));
  void entries;
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (lastPage) {
    console.log(JSON.stringify(await lastPage.evaluate("globalThis.demo ? { brain: demo.brain(), banner: demo.state.banner, items: demo.items().slice(-4).map(i => ({ kind: i.kind, text: String(i.text ?? '').slice(0, 160) })) } : null").catch((e: Error) => e.message)));
    console.log(lastPage.console.filter((l) => !l.startsWith("debug")).slice(-15).join("\n"));
    await lastPage.screenshot(join(shots, "brain-failed.png")).catch(() => undefined);
  }
} finally {
  for (const c of children) c.kill();
  for (const close of closers) try { close(); } catch { /* closing */ }
  cdp.close();
}
console.log(failed ? `${failed} FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
