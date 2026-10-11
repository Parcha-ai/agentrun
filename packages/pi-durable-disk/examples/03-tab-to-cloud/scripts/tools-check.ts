// Hill 2 in a real browser: the trained model (a merged GGUF that learned pi's read/write/edit/bash) drives pi's real tools on the in-browser computer, in ONE conversation
// (?configure=1: the trip's conversation is configured onto the model). A run in a local server, the model comes home, the page loads it and configures the conversation, then the user
// asks for work and the model's tool turns are decoded (thinking capped, free text, the call under the format's grammar) and run by pi's tools on the Wasmer sandbox; every write-through
// goes to the pipe's disk.
//   MODEL_DISK=<dir holding home/model/manifest.json and the chunks> [TASK="..."] [CDP=http://127.0.0.1:9333] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/tools-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const MODEL_DISK = process.env.MODEL_DISK;
if (!MODEL_DISK || !existsSync(join(MODEL_DISK, "home/model/manifest.json"))) throw new Error("MODEL_DISK must hold home/model/manifest.json and the chunks");
const shots = process.env.SHOTS ?? "/tmp";
const task = process.env.TASK ?? "Write hello.js that prints hi, then run it.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "tools-check-"));
const port = await freePort();
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--local", dir, "--run", "tools", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/model/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9333");
const device = await cdp.device();
const extra = process.env.PARAMS ? `&${process.env.PARAMS}` : "";
const url = `http://127.0.0.1:${port}${link}`.replace("#", `?configure=1&threads=${process.env.THREADS ?? "6"}${extra}#`);
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
try {
  page = await device.open(url);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  console.log(`${at()} s: the agent runs in the tab with its computer`);
  const dest = join(dir, "runs", "tools", "work/home/model");
  mkdirSync(dest, { recursive: true });
  const names = readdirSync(join(MODEL_DISK, "home/model")).sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)));
  for (const n of names) copyFileSync(join(MODEL_DISK, "home/model", n), join(dest, n));
  const came = Date.now();
  await page.until("demo.brain().swapped === true || /did not load/.test(demo.state.brainStatus)", 400_000, 1000);
  console.log(`${at()} s: ${((Date.now() - came) / 1000).toFixed(1)} s after the manifest: ${JSON.stringify(await ev("demo.brain()"))}`);
  const first = await ev<{ conversation: string }>("demo.brain()");
  const rootId = await ev<string>("String(demo.state.runtime.root.id)");
  ok("ONE conversation: the model's conversation is the trip's own (the root)", first.conversation === rootId, { first, rootId });

  type Turn = { ms: number; tokensPerSecond: number | null; promptTokens: number; outputTokens: number; thinkTokens: number; calls: number; thinkingCut: boolean; cut: boolean; call: string | null; problem: string | null; raw: string; completions: { ms?: number; promptTokens: number; outputTokens: number; stoppedBy: string; timings?: Record<string, number> }[] };
  // The check is ours, in code: the exact output of a command on the workspace, never the model's own claim.
  const tasks: { task: string; check: string; expect: string }[] = process.env.TASK
    ? [{ task: process.env.TASK, check: "ls", expect: "" }]
    : [
        { task: "Write hello.js that prints hi, then run it.", check: "node hello.js", expect: "hi" },
        { task: "Create notes/a.txt containing apple and notes/b.txt containing banana, then tell me how many lines each file has.", check: "cat notes/a.txt; echo ---; cat notes/b.txt", expect: "apple\n---\nbanana" },
        { task: "Change hello.js so it prints hello world instead of hi, then run it.", check: "node hello.js", expect: "hello world" },
        { task: "Write squares.js that prints the squares of 1 to 5, one per line, then run it.", check: "node squares.js", expect: "1\n4\n9\n16\n25" },
      ];
  let seenTurns = 0;
  const all: { turns: Turn[]; ok: boolean }[] = [];
  for (const [n, t] of tasks.entries()) {
    const before = await ev<number>("demo.items().length");
    await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(t.task)}; document.getElementById("send").click(); return true; })()`);
    const started = Date.now();
    await sleep(3000);
    await page.until("(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()", 900_000, 2000).catch(() => undefined);
    const wall = (Date.now() - started) / 1000;
    const items = await ev<{ kind: string; text?: string; name?: string; args?: string; status?: string; output?: string }[]>("demo.items().slice(" + before + ")");
    const turns = (await ev<Turn[]>("demo.toolTurns()")).slice(seenTurns);
    seenTurns += turns.length;
    console.log(`\n== TASK ${n + 1}: ${t.task}\nwall ${wall.toFixed(1)} s, ${turns.length} model turns`);
    for (const [i, x] of turns.entries()) {
      const parts = x.completions.map((c) => `${c.stoppedBy}:${c.ms}ms/${c.outputTokens}tok/prompt_n=${c.timings?.prompt_n ?? "?"}/pp=${c.timings?.prompt_per_second ? Math.round(c.timings.prompt_per_second) : "?"}t/s/gen=${c.timings?.predicted_per_second ? Math.round(c.timings.predicted_per_second * 10) / 10 : "?"}t/s`).join(" | ");
      console.log(`  turn ${i + 1}: ${(x.ms / 1000).toFixed(1)} s, out ${x.outputTokens} tok (thinking ${x.thinkTokens}), thinkingCut=${x.thinkingCut} cut=${x.cut}\n    ${parts}\n    ${x.call ? "call " + x.call.slice(0, 220) : "answer"}${x.problem ? "\n    PROBLEM " + x.problem : ""}`);
    }
    for (const i of items.filter((x) => x.kind === "tool" || x.kind === "assistant")) if (i.kind === "tool") console.log(`  [tool ${i.status}] ${i.name} -> ${JSON.stringify((i.output ?? "").slice(0, 140))}`); else if (i.text) console.log(`  [answer] ${JSON.stringify(i.text.slice(0, 160))}`);
    const verdict = await ev<{ exitCode?: number; output?: string }>(`demo.exec(${JSON.stringify(t.check)})`).catch((): { exitCode?: number; output?: string } => ({ output: "" }));
    const good = verdict.exitCode === 0 && (verdict.output ?? "").trim() === t.expect;
    console.log(`  verification \`${t.check}\`: ${JSON.stringify((verdict.output ?? "").slice(0, 120))} -> ${good ? "RIGHT" : "WRONG"}`);
    all.push({ turns, ok: good });
  }
  const allTurns = all.flatMap((a) => a.turns);
  const gen = allTurns.flatMap((x) => x.completions).filter((c) => c.timings?.predicted_per_second).map((c) => c.timings!.predicted_per_second!);
  const pp = allTurns.flatMap((x) => x.completions).filter((c) => c.timings?.prompt_per_second && (c.timings.prompt_n ?? 0) > 20).map((c) => c.timings!.prompt_per_second!);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  console.log(`\nSUMMARY: ${all.filter((a) => a.ok).length}/${all.length} tasks verified right; ${allTurns.length} model turns, mean ${avg(allTurns.map((x) => x.ms / 1000))} s per turn; generation ${avg(gen)} tok/s, prompt evaluation ${avg(pp)} tok/s (calls that evaluated >20 prompt tokens); calls with a grammar problem: ${allTurns.filter((x) => x.problem).length}/${allTurns.length}; thinking cut ${allTurns.filter((x) => x.thinkingCut).length}; answers cut ${allTurns.filter((x) => x.cut).length}`);
  ok("every call the grammar decoded parsed (no call problem)", allTurns.every((x) => x.problem === null), allTurns.map((x) => x.problem));
  ok("pi's real tools ran the model's calls", allTurns.some((x) => x.call !== null));
  await page.screenshot(join(shots, "tools-1.png"));
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ brain: demo.brain(), banner: demo.state.banner, status: demo.state.brainStatus, items: demo.items().slice(-5).map(i => ({ kind: i.kind, text: String(i.text ?? i.name ?? '').slice(0, 120) })), turns: demo.toolTurns().slice(-3) }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-12).join("\n"));
    await page.screenshot(join(shots, "tools-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
