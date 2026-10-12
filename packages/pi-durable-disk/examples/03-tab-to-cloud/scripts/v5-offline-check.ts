// The offline beat, in real Chrome with the REAL v5 files: the laptop's agent page keeps the robot's brain (v5, the 16-tag prompt) in the browser while it is online,
// "Take it offline" checks the run out with nothing left to download, the network is cut, and the robot answers on the model in the page: a colour, a face, a name, a
// state question, a skill that is home, and a body edit (refused, the body is code). Nothing is scripted but the questions; the answers are the model's.
//   MODELS=<folder with the /models/ files> [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] [TURNS=...] node scripts/v5-offline-check.ts
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
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1#"));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await page.until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000, 300);
  // 1. online: the brain is kept in this browser (no engine started)
  await page.until("demo.v5().prefetch === 'done' || demo.v5().prefetch === 'failed' || demo.v5().prefetch === 'unavailable'", 600_000, 1000);
  const kept = await ev<{ prefetch: string; prefetchText: string; ready: boolean; log: string[] }>("demo.v5()");
  ok("online: the robot's brain is kept in this browser (parts and warm state), and no model is loaded", kept.prefetch === "done" && kept.ready === false, kept);
  const opfs = await ev<number>(`(async () => { let n = 0; const walk = async (d) => { for await (const [, h] of d.entries()) { if (h.kind === "file") n += (await h.getFile()).size; else await walk(h); } }; await walk(await navigator.storage.getDirectory()); return n; })()`);
  ok("it is in the browser's file system: more than the model's 501 MB", opfs > 500_000_000, opfs);
  // 2. take it offline: only a check-out, no download of the model
  const before = await ev<number>(`performance.getEntriesByType("resource").filter((r) => /\.gguf$|state\.bin$/.test(r.name)).length`);
  await ev("document.getElementById('offline').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 600_000, 500);
  ok("the run was checked out to the browser", (await ev<string>("demo.state.mode")) === "offline", await ev("demo.state.banner"));
  // 3. the brain comes up from the cache
  await page.until("demo.v5().ready || /did not load/.test(demo.state.banner)", 600_000, 1000);
  const up = await ev<{ ready: boolean; build: string; marks: Record<string, number>; log: string[] }>("demo.v5()");
  ok("the model loaded from the browser's cache and can answer", up.ready, { banner: await ev("demo.state.banner"), log: up.log.slice(-6) });
  ok("its warm state was restored, not prefilled", up.log.some((l) => /warm state restored: \d+ tokens/.test(l)) && !up.log.some((l) => /no warm state restored/.test(l)), up.log.slice(-8));
  ok("the model came from the cache: nothing of it was downloaded since the checkout", (await ev<number>(`performance.getEntriesByType("resource").filter((r) => /\.gguf$|state\.bin$/.test(r.name)).length`)) === before, up.marks);
  console.log(`  marks: ${JSON.stringify(up.marks)} build ${up.build}`);
  await page.screenshot(join(shots, "v5-1-offline-ready.png"));
  // 4. the network is cut: the model answers anyway
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const turns = Number(process.env.TURNS ?? 6);
  const bodyXml = (await ev<{ output?: string }>(`demo.exec("sha256sum robot/body.xml")`)).output?.slice(0, 64);
  const asked: [string, (items: Item[]) => Promise<[boolean, unknown]>][] = [
    ["paint its legs red", async (items) => { const r = await robotJson(); return [items.some((i) => i.kind === "tool" && i.name === "set_color" && i.status === "done") && r.look?.tags?.legs === "red", { tags: r.look?.tags, items }]; }],
    ["give it a happy face", async (items) => { const r = await robotJson(); return [items.some((i) => i.kind === "tool" && i.name === "set_face") && r.look?.face === "happy", { face: r.look?.face, items }]; }],
    ["call it Rex", async (items) => { const r = await robotJson(); return [items.some((i) => i.kind === "tool" && i.name === "rename") && r.name === "Rex", { name: r.name, items }]; }],
    ["what color are its legs?", async (items) => [!items.some((i) => i.kind === "tool") && items.some((i) => i.kind === "assistant" && /red/i.test(i.text ?? "")), items]],
    ["make it sprint", async (items) => [items.some((i) => i.kind === "tool" && i.name === "do" && i.status === "done" && /sprint/.test(i.output ?? "")), items]],
    ["make it twice as big", async (items) => { const sizeTool = items.find((i) => i.kind === "tool" && ["scale", "resize"].includes(i.name ?? "")); const xml = (await ev<{ output?: string }>(`demo.exec("sha256sum robot/body.xml")`)).output?.slice(0, 64); return [(sizeTool ? /built from code/.test(sizeTool.output ?? "") : true) && xml === bodyXml, { chose: items.filter((i) => i.kind === "tool").map((i) => i.name), bodyXml, xml, items }]; }],
  ];
  const wording = ["offline: a colour on a tag of the code body", "offline: a face", "offline: a new name", "offline: a state question is answered from the state line, no tool", "offline: a skill that is home", "offline: a body edit never changes the code body: a size tool is answered with the refusal, the file is as it was"];
  for (const [i, [question, check]] of asked.slice(0, turns).entries()) {
    const items = await say(question);
    const [pass, got] = await check(items);
    ok(wording[i]!, pass, got);
  }
  await page.screenshot(join(shots, "v5-2-offline-turns.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, v5: demo.v5(), items: demo.items().slice(-6) }) : null)()").catch(() => null)).slice(0, 2500));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-10).join("\n"));
    await page.screenshot(join(shots, "v5-failed.png")).catch(() => undefined);
  }
} finally {
  await page?.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => undefined);
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
