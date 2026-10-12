// The robot demo's local brain in real Chrome, end to end: MiniCPM5-2B (a model with its own tool template, loaded from the run's disk) answers in the agent's page and changes the robot by tool calls.
// No cloud model is involved after the load. Prompts are typed in the chat; each turn prints how long it took, what the model called and the robot's resulting state; then the network is cut and one more edit is made.
//   MODEL=<minicpm5-2b.gguf> [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/minicpm-robot-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const here = import.meta.dirname;
const fixture = join(here, "../../04-walks-home/policy/test/fixtures/policy.json");
const policyText = readFileSync(fixture, "utf8");
const sha = (JSON.parse(policyText) as { mjcf_sha256: string }).mjcf_sha256;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "robot-pane-"));
const port = await freePort();
const RUN = "rp";
const work = join(dir, "runs", RUN, "work");
mkdirSync(join(work, "home/skills"), { recursive: true });
copyFileSync(fixture, join(work, "home/policy.json"));
for (const n of ["walk", "sprint"]) copyFileSync(fixture, join(work, `home/skills/${n}.json`));
writeFileSync(join(work, "home/skills.json"), JSON.stringify({ version: 1, body_mjcf_sha256: sha, default: "walk", skills: { walk: { policy: "skills/walk.json", command: 0.3, label: "walk" }, sprint: { policy: "skills/sprint.json", command: 0.7, label: "sprint" } } }));
const model = process.env.MODEL;
if (!model || !existsSync(model)) throw new Error("MODEL=<path to the MiniCPM5-2B GGUF> is required");
// laid out as a base with no adapters (home/files/<sha256>-<chunk>/, home/manifest.json): the tab keeps such a file in OPFS and hands wllama a File read from disk. The chunk-list layout would build ONE in-memory Blob
// of the whole model, which Chrome could not read back above ~1.5 GB (measured: 1.26 GB reads, 1.64 GB fails with NotReadableError).
await new Promise<void>((resolve, reject) => { const p = spawn(process.execPath, [join(here, "../../04-walks-home/tab/scripts/make-home-disk.mjs"), join(dir, "runs", RUN, "work"), "--base", model, "--base-model", "openbmb/MiniCPM5-2B-GGUF@2079a22f3beaa4e306449978533478fe0522f4b3", "--base-name", "MiniCPM5-2B", "--base-quant", "Q4_K_M", "--standalone"], { stdio: "inherit" }); p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`make-home-disk exited ${c}`)))); });
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/files/", "--no-restore", "home/model/"], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
/** The creature page's own `__walks`, through the iframe (same origin). */
const walks = <T>(expr: string) => ev<T>(`(() => { const w = document.getElementById("creature").contentWindow.__walks; return ${expr}; })()`);
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string };
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
const say = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(2500);
  await page!.until(idle, 120_000, 1000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
const call = (name: string, args: Record<string, unknown>) => `{ call: { name: ${JSON.stringify(name)}, arguments: ${JSON.stringify(args)} } }`;
const script = async (turns: string[]) => ev(`demo.stubCloud([${turns.join(", ")}, { text: "Done." }])`);
const until = (expr: string, ms = 30_000) => page!.until(expr, ms, 300);
const turns: { prompt: string; ms: number; calls: string[]; reply: string; robot: string }[] = [];
try {
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1&template=native&threads=" + (process.env.THREADS ?? "8") + "#"));
  const t0 = Date.now();
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000);
  console.log(`page up after ${((Date.now() - t0) / 1000).toFixed(0)} s; model status: ${await ev<string>("demo.state.brainStatus")}`);
  await page.until("demo.brain().swapped && demo.brain().phase === 'answered'", 900_000, 1000).catch(async (e) => { console.log("status", JSON.stringify(await ev<unknown>("demo.brain()"))); throw e; });
  await page.until("demo.state.brainStatus === ''", 300_000, 500).catch(() => undefined);
  await sleep(3000); // the warm-up is a throwaway one-token turn: a command sent now waits for it
  console.log(`the model is loaded and warm after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await page.screenshot(join(shots, "minicpm-1-loaded.png"));
  const ask = async (prompt: string) => {
    const t = Date.now();
    const before = await ev<number>("demo.items().length");
    await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(prompt)}; document.getElementById("send").click(); return true; })()`);
    // the model's turn: wait for its answer (a new assistant item that stays the last one), however long a 2B model on this box takes
    await page!.until(`demo.items().length > ${before} && !demo.state.chat.busy`, 300_000, 500).catch(() => undefined);
    await sleep(1500);
    await page!.until(`!demo.state.chat.busy`, 300_000, 500).catch(() => undefined);
    const items = await ev<Item[]>(`demo.items().slice(${before})`);
    const ms = Date.now() - t;
    const calls = items.filter((i) => i.kind === "tool").map((i) => `${i.name}`);
    const reply = items.filter((i) => i.kind === "assistant" || i.kind === "text").map((i) => i.text ?? "").join(" ").trim();
    const robot = await walks<string>("JSON.stringify({ look: w.look(), fits: w.fits() })").catch(() => "");
    console.log(`  items: ${JSON.stringify(items.map((i) => ({ k: i.kind, n: i.name, t: (i.text ?? i.output ?? "").slice(0, 100) })))}`);
    console.log(`  brain: ${JSON.stringify(await ev<unknown>("demo.brain()"))}`);
    turns.push({ prompt, ms, calls, reply, robot });
    console.log(`> ${prompt}\n  ${(ms / 1000).toFixed(1)} s  calls: ${calls.join(", ") || "(none)"}  reply: ${reply.slice(0, 160)}\n  robot: ${robot.slice(0, 200)}`);
    return { items, calls, reply };
  };
  const a = await ask("make it a red spider");
  ok("'make it a red spider' calls the tools (morph and/or set_color)", a.calls.some((c) => /morph|set_color|update_robot/.test(c)), a.calls);
  await page.screenshot(join(shots, "minicpm-2-spider.png"));
  const b = await ask("hi, who are you?");
  ok("chat is answered without a tool call", b.calls.length === 0, b.calls);
  const c = await ask("make it sprint");
  ok("'make it sprint' calls do", c.calls.includes("do") || c.calls.includes("update_robot"), c.calls);
  const d = await ask("give it a happy face and call it Spidey");
  ok("a face and a name", d.calls.length >= 1, d.calls);
  // wild asks, the kind that tempt a free-text parameter out of its enum (D1/D2 measured "purpel", "cat", "wiggles", factor 3 from this model): what the robot ends up as, and whether the tools' refusals were needed
  for (const wild of ["paint it purpel", "turn it into a cat", "make it wiggle", "make it 3 times bigger"]) {
    const w = await ask(wild);
    const refusals = w.items.filter((i) => i.kind === "tool" && /^Not done|must be one of|refus/i.test(i.output ?? i.text ?? "")).length;
    console.log(`  wild: ${JSON.stringify(wild)} tools=${w.calls.join("+") || "-"} refused=${refusals}`);
  }
  console.log(`tool turns (model ms, prompt tokens, output tokens): ${JSON.stringify((await ev<{ ms: number; promptTokens: number; outputTokens: number }[]>("demo.toolTurns()")).map((t) => [t.ms, t.promptTokens, t.outputTokens]))}`);
  await page.screenshot(join(shots, "minicpm-3-after.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
  console.log(JSON.stringify(turns.map((t) => ({ p: t.prompt, s: +(t.ms / 1000).toFixed(1), calls: t.calls })), null, 1));
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, brainStatus: demo.state.brainStatus, items: demo.items().slice(-4).map(i => ({ kind: i.kind, text: String(i.text ?? i.output ?? '').slice(0, 160) })) }) : null)()").catch(() => null)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-12).join("\n"));
    await page.screenshot(join(shots, "minicpm-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
