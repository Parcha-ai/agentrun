// The phone page (?phone=1) on the REAL v5 files in real Chrome: the brain loads from the served /models/ folder through the shared startV5Brain, the composer opens, and the model answers a
// colour, a state question and a skill. The page needs no run on the server: its store, files and model are in the browser.
//   MODELS=<folder served as /models/> [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/v5-phone-check.ts
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
const models = process.env.MODELS;
if (!models || !existsSync(join(models, "qwen35-0.8b-robot-v5t-Q4_0.serving.json"))) throw new Error("MODELS must name the folder served as /models/ (the v5 parts, parts.json, and the v5t serving and state files)");
const here = import.meta.dirname;
const fixture = join(here, "../../04-walks-home/policy/test/fixtures/policy.json");
const policyText = readFileSync(fixture, "utf8");
const sha = (JSON.parse(policyText) as { mjcf_sha256: string }).mjcf_sha256;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "v5-offline-"));
const port = await freePort();
const RUN = "v5";
const work = join(dir, "runs", RUN, "work");
mkdirSync(join(work, "home/skills"), { recursive: true });
copyFileSync(fixture, join(work, "home/policy.json"));
for (const n of ["walk", "sprint"]) copyFileSync(fixture, join(work, `home/skills/${n}.json`));
writeFileSync(join(work, "home/skills.json"), JSON.stringify({ version: 1, body_mjcf_sha256: sha, default: "walk", skills: { walk: { policy: "skills/walk.json", command: 0.3, label: "walk" }, sprint: { policy: "skills/sprint.json", command: 0.7, label: "sprint" } } }));
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--models-dir", models, "--no-restore", "home/files/", "--no-restore", "home/model/"], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
const walks = <T>(expr: string) => ev<T>(`(() => { const w = document.getElementById("creature").contentWindow.__walks; return ${expr}; })()`);
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string };
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
/** One question to the model in the page; its items, once the agent is idle again. */
const say = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  const started = Date.now();
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(3000);
  await page!.until(idle, 300_000, 1000).catch(() => undefined);
  const items = await ev<Item[]>(`demo.items().slice(${before})`);
  console.log(`  "${text}" -> ${Math.round((Date.now() - started) / 1000)} s: ${items.map((i) => (i.kind === "tool" ? `${i.name}[${i.status}] ${(i.output ?? "").slice(0, 90)}` : `${i.kind}: ${(i.text ?? "").slice(0, 90)}`)).join(" | ")}`);
  return items;
};
const robotJson = async () => JSON.parse((await ev<{ output?: string }>(`demo.exec("cat creature/robot.json")`)).output ?? "{}") as { name?: string; look?: { face?: string; tags?: Record<string, string | null>; torso?: string } };
try {
  page = await device.open(`http://127.0.0.1:${port}/?phone=1&offline=0&report=0`);
  await page.until("globalThis.demo && (demo.state.phone?.ready === true || demo.state.mode === 'lost')", 900_000, 1000);
  const phone = await ev<{ ready: boolean; log: string[]; marks: Record<string, number> }>("({ ready: demo.state.phone.ready, log: demo.state.phone.log, marks: demo.state.phone.marks })");
  ok("the phone page's brain came up and the composer is open (startV5Brain handed ready the brain)", phone.ready === true && (await ev<string>("demo.state.mode")) === "offline", { banner: await ev("demo.state.banner"), log: phone.log.slice(-6) });
  console.log(`  marks: ${JSON.stringify(phone.marks)}`);
  ok("its warm state was restored from the V5T file", phone.log.some((l) => /warm state restored: \d+ tokens/.test(l)), phone.log.slice(-8));
  const colour = await say("paint it yellow");
  ok("a colour: the model called set_color", colour.some((i) => i.kind === "tool" && i.name === "set_color" && i.status === "done"), colour);
  const state = await say("what color is the robot now?");
  ok("a state question is answered with no tool", !state.some((i) => i.kind === "tool") && state.some((i) => i.kind === "assistant" && /yellow/i.test(i.text ?? "")), state);
  ok("the thinking timer started (turnStarted was set by the turn-start report)", (await ev<number | undefined>("demo.state.phone.turnStarted")) !== undefined);
  await page.screenshot(join(shots, "v5-phone.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, phone: demo.state.phone && { phase: demo.state.phone.phase, log: demo.state.phone.log.slice(-8) }, items: demo.items().slice(-4) }) : null)()").catch(() => null)).slice(0, 2500));
    await page.screenshot(join(shots, "v5-phone-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
