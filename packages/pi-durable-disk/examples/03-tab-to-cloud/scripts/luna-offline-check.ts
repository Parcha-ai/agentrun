// Does the REAL cloud model call go_offline only when the user has said yes? A real model through the server's model proxy, the page in real Chrome, `?golive=1`, no 1B turns (the run is only
// asked to go offline; the check is about when the cloud model calls the tool). Prompts that must NOT make it call go_offline (the user is thinking out loud, asks about it, asks for ordinary work)
// and one that must (the user says yes). Spend is capped by the server's token budget (BUDGET, default 60000 tokens) and printed at the end.
//   MODEL=<id> MODEL_URL=<an OpenAI Responses endpoint> [KEY_ENV=<name of the env var holding the key>] MODEL_DISK=<dir with home/model/> [BUDGET=60000] [CDP=http://127.0.0.1:9334] node scripts/luna-offline-check.ts
//   (an endpoint that needs a key: run it under the machine's credential wrapper; the key is read from the environment and never printed)
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const need = (name: string) => { const v = process.env[name]; if (!v) throw new Error(`${name} must be set`); return v; };
const MODEL = need("MODEL"), MODEL_URL = need("MODEL_URL"), MODEL_DISK = need("MODEL_DISK"), KEY_ENV = process.env.KEY_ENV; // KEY_ENV: only for an endpoint that needs a key (not the local broker)
if (KEY_ENV && !process.env[KEY_ENV]) throw new Error(`${KEY_ENV} is not set: run this under the credential wrapper`);
if (!existsSync(join(MODEL_DISK, "home/model/manifest.json"))) throw new Error("MODEL_DISK must hold home/model/manifest.json and the chunks");
const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "luna-"));
const port = await freePort();
const log: string[] = [];
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", "lu", "--model", MODEL, "--model-url", MODEL_URL, ...(KEY_ENV ? ["--model-key-env", KEY_ENV] : []), "--budget", process.env.BUDGET ?? "60000", "--grace-ms", "3000", "--no-restore", "home/model/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; log.push(String(d)); });
server.stderr!.on("data", (d) => log.push(String(d)));
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string };
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
const send = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(3000);
  await page!.until(idle, 180_000, 1000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
const said = (items: Item[]) => items.filter((i) => i.kind === "assistant").map((i) => i.text ?? "").join(" ").replace(/\s+/g, " ");
const called = (items: Item[]) => items.some((i) => i.kind === "tool" && i.name === "go_offline");
const SHOULD_NOT = [
  "I might lose my wifi on the train in an hour. What would happen to you if that happened?",
  "What does your go_offline tool do, exactly? Just explain, don't use it.",
  "Write hello.js that prints hi and run it.",
  "I'll probably be offline later today, I'm not sure yet.",
];
try {
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?golive=1#"));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  const dest = join(dir, "runs", "lu", "work/home/model");
  mkdirSync(dest, { recursive: true });
  for (const n of readdirSync(join(MODEL_DISK, "home/model")).sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)))) copyFileSync(join(MODEL_DISK, "home/model/", n), join(dest, n));
  for (const prompt of SHOULD_NOT) {
    const items = await send(prompt);
    console.log(`  ${JSON.stringify(prompt.slice(0, 60))} -> ${called(items) ? "CALLED go_offline" : "no call"}: ${JSON.stringify(said(items))}`);
    ok(`no go_offline for: ${prompt.slice(0, 70)}`, !called(items), items.map((i) => `${i.kind}${i.name ? ":" + i.name : ""}`));
    if (called(items)) break; // the run is moving offline: the rest would measure something else
  }
  if ((await ev<string>("demo.state.mode")) === "writer") {
    const yes = await send("Yes, I'm boarding now. Please go offline.");
    console.log(`  yes -> ${called(yes) ? "called go_offline" : "no call"}: ${JSON.stringify(said(yes))}`);
    ok("after the user says yes, it calls go_offline", called(yes), yes.map((i) => `${i.kind}${i.name ? ":" + i.name : ""}`));
  }
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
} finally {
  const spend = log.join("").split("\n").filter((l) => /model\.usage/.test(l)).slice(-1)[0] ?? "(no usage line)";
  console.log(`spend: ${spend.replace(/\s+/g, " ").slice(0, 300)}`);
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
