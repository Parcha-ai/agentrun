// The session in code mode, end to end in real Chrome: the run starts with a default robot that is code (seeded into the workspace, compiled and shown by the creature page, reported in robot/build.json), then the agent (the cloud model is
// scripted, the tools are real, the computer is the page's Wasmer sandbox running node) writes a dinosaur's robot/body.mjs, runs `node robot/build.mjs`, calls build_robot (which reports what the page made of it) and paints the plates:
// the page shows the dinosaur, standing, with orange plates, and the preset tools are not among the agent's tools.
//   [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/code-pane-check.ts
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
const dinoSource = readFileSync(join(here, "../../04-walks-home/body/dino.example.mjs"), "utf8");
try {
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1&brain=off#"));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000);
  // 1. the session starts as code: the default robot is in the workspace, built, and on screen
  await until(`document.getElementById("creature").contentWindow.__walks.app.built.code === true`, 90_000);
  const files = await ev<string[]>("demo.files()");
  ok("the workspace starts with the helper files and a default robot (body.mjs, body.xml, body.json)", ["robot/lib.mjs", "robot/build.mjs", "robot/body.mjs", "robot/body.xml", "robot/body.json", "robot/examples/dog.mjs", "robot/examples/dino.mjs"].every((f) => files.includes(f)), files.filter((f) => f.startsWith("robot")));
  ok("the creature page shows that robot, as code, standing", (await walks<number>("w.app.sim.uprightness()")) > 0.9 && (await walks<number>("w.app.built.jointNames.length")) === 8);
  await until(`demo.exec("cat robot/build.json").then((r) => r.exitCode === 0 && JSON.parse(r.output).ok === true)`, 30_000).catch(() => undefined);
  const first = await ev<{ exitCode?: number; output?: string }>(`demo.exec("cat robot/build.json")`);
  ok("and the page reported it: robot/build.json is ok, 8 motors", /"ok": ?true/.test(first.output ?? "") && /"motors": ?8/.test(first.output ?? ""), first.output?.slice(0, 200));
  const fonts = await ev<{ mono: boolean; label: string }>(`(async () => { const d = document.getElementById("creature").contentWindow.document; await d.fonts.load('500 11px "JetBrains Mono"'); await d.fonts.load('400 14px "Inter"'); const loaded = (f) => [...d.fonts].some((x) => x.family.replace(/"/g, "") === f && x.status === "loaded"); return { mono: loaded("JetBrains Mono") && loaded("Inter"), label: getComputedStyle(d.getElementById("stateLabel")).fontFamily }; })()`);
  ok("the creature page uses the demo's fonts (Inter and JetBrains Mono from /theme/), its label set in the mono", fonts.mono && /JetBrains Mono/.test(fonts.label), fonts);
  await page.screenshot(join(shots, "code-1-default.png"));

  // 2. the agent writes a dinosaur, builds it, checks it, paints the plates
  await script([
    call("write", { path: "robot/body.mjs", content: dinoSource }),
    call("bash", { command: "node robot/build.mjs" }),
    call("build_robot", {}),
    call("set_color", { part: "plates", color: "orange" }),
  ]);
  const items = await say("make me a dinosaur robot, with orange plates down its back");
  const tool = (name: string) => items.find((i) => i.kind === "tool" && i.name === name);
  ok("the agent wrote body.mjs, and the build ran in the page's computer: one summary line", tool("write")?.status === "done" && /wrote robot\/body\.xml and robot\/body\.json: 32 pieces, 8 motors, 10 spring joints/.test(tool("bash")?.output ?? ""), tool("bash")?.output);
  ok("build_robot reported what the page made of it", /^Built dino: 32 pieces, 8 motors, 10 spring joints, [\d.]+ kg, stands 0\.\d+ m high\. Tags: torso, head, neck, tail, legs, front_legs, back_legs, eyes, jaw, belly, plates\./.test(tool("build_robot")?.output ?? ""), tool("build_robot")?.output);
  ok("and the plates are orange through set_color", /The plates are now orange\./.test(tool("set_color")?.output ?? ""), tool("set_color")?.output);
  await until(`document.getElementById("creature").contentWindow.__walks.app.view.parts.filter((p) => p.tags && p.tags.includes("plates")).every((p) => "#" + p.mesh.material.color.getHexString() === "#f08a24")`, 30_000).catch(() => undefined);
  const shown = await walks<{ pieces: number; plates: string[]; up: number }>(`({ pieces: w.app.view.parts.filter((p) => p.tags).length, plates: w.app.view.parts.filter((p) => p.tags.includes("plates")).map((p) => "#" + p.mesh.material.color.getHexString()), up: w.app.sim.uprightness() })`);
  ok("the creature on screen is the dinosaur: 32 pieces, standing, four orange plates", shown.pieces === 32 && shown.up > 0.9 && shown.plates.length === 4 && shown.plates.every((c) => c === "#f08a24"), shown);
  await page.screenshot(join(shots, "code-2-dino.png"));
  await ev(`document.querySelectorAll("details.tool").forEach((d) => { d.open = true; })`); // what the user sees when they open the work: the written file, the build, the check
  await sleep(500);
  await page.screenshot(join(shots, "code-3-work-open.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, files: demo.files().filter((f) => f.startsWith('robot')), items: demo.items().slice(-6).map(i => ({ kind: i.kind, name: i.name, status: i.status, out: String(i.output ?? i.text ?? '').slice(0, 160) })) }) : null)()").catch(() => null)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-10).join("\n"));
    await page.screenshot(join(shots, "code-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
