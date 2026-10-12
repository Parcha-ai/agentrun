// The robot in the agent's page, in real Chrome, end to end: the creature page runs in an iframe under /tab/ and reads and writes its files through the page's workspace. The agent's robot tools
// (the cloud model is scripted: the tools are real) edit creature/robot.json; the creature redraws; a body change stumbles; do(skill) switches the policy live; then the run is checked out, the
// network cut, and the robot still redraws and walks, with the assets from the service worker's cache; a reload offline keeps the changes.
//   [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/robot-pane-check.ts
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
try {
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1&brain=off#"));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000);
  ok("the creature page runs in the agent's page, under /tab/ on the same origin", await ev<boolean>(`document.getElementById("creature").contentWindow.location.pathname === "/tab/"`));
  await until(`document.getElementById("creature").contentWindow.__walks.state().policy !== null && document.getElementById("creature").contentWindow.__walks.state().policy !== undefined`, 60_000).catch(() => undefined);
  console.log(`  creature state: ${JSON.stringify(await walks<unknown>("w.state()")).slice(0, 220)}`);
  ok("it read home/policy.json through the page's workspace: a trained policy drives the creature", /trained/.test(await ev<string>(`document.getElementById("creature").contentDocument.getElementById("stateLabel").textContent`)), await ev(`document.getElementById("creature").contentDocument.getElementById("stateLabel").textContent`));
  await page.screenshot(join(shots, "pane-1-start.png"));

  // looks: the agent's tool writes creature/robot.json, the creature redraws
  await script([call("set_color", { part: "legs", color: "red" }), call("set_face", { face: "happy" })]);
  const t1 = await say("make the legs red and give it a happy face");
  ok("the robot tools ran in the page's computer", t1.filter((i) => i.kind === "tool" && i.status === "done").length >= 2, t1.map((i) => `${i.kind}:${i.name ?? ""}:${i.status ?? ""}`));
  await until(`document.getElementById("creature").contentWindow.__walks.look().face === "happy"`).catch(() => undefined);
  const look = await walks<{ legs: string[]; face: string }>("w.look()");
  ok("looks only: the creature redrew (legs red, a happy face) and the brain still fits", look.legs.every((c) => c === "#d9423b") && look.face === "happy" && (await walks<boolean>("w.fits()")), look);

  // a body change: the old brain drives the new body, the label says so
  await script([call("resize", { part: "leg_length", factor: 1.3 })]);
  await say("make the legs a lot longer");
  await until(`document.getElementById("creature").contentWindow.__walks.fits() === false`).catch(() => undefined);
  ok("a body change: the creature page says its brain no longer fits (it stumbles)", (await walks<boolean>("w.fits()")) === false && /no longer fits/.test(await ev<string>(`document.getElementById("creature").contentDocument.getElementById("stateLabel").textContent`)));
  ok("and the new body was saved through the page: creature/creature.xml is in the workspace", (await ev<{ exitCode?: number; output?: string }>("demo.exec('ls creature')")).output?.includes("creature.xml") === true);

  // a skill
  await script([call("do", { skill: "sprint" })]);
  const t3 = await say("sprint!");
  await until(`document.getElementById("creature").contentWindow.__walks.skill() === "sprint"`).catch(() => undefined);
  ok("do(sprint): the agent's tool accepted a skill that came home, and the creature page switched to it", t3.some((i) => i.kind === "tool" && i.name === "do" && i.status === "done") && (await walks<string>("w.skill()")) === "sprint", t3.map((i) => `${i.name ?? i.kind}:${i.status ?? ""}:${(i.output ?? "").slice(0, 80)}`));
  await page.screenshot(join(shots, "pane-2-online.png"));
  const changes = await ev<string>(`document.getElementById("creature").contentWindow.__walks.app.bodySha`);

  // offline: checkout, the network cut, the robot still redraws
  await ev("demo.goOffline = demo.goOffline"); // (the page's own button is used below)
  await ev("document.getElementById('offline').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 300_000, 500);
  ok("the run was checked out (the creature page's files are cached with the page)", (await ev<string>("demo.state.mode")) === "offline", await ev("demo.state.banner"));
  const cached = await ev<string[]>(`caches.open("walks-home-offline-v1").then((c) => c.keys()).then((ks) => ks.map((k) => new URL(k.url).pathname).filter((p) => p.startsWith("/tab/")))`);
  ok("the service worker holds the creature page and MuJoCo's wasm", cached.includes("/tab/") && cached.includes("/tab/main.js") && cached.some((p) => p.endsWith("mujoco.wasm")), cached);
  await page.send("Network.enable");
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  await page.until("demo.net().online === false", 20_000, 300);
  await sleep(1000);
  // the offline brain is the computer's tools here (no model in this check): the robot's file is edited with the page's own computer, the way a tool would, and the creature must follow
  const edited = await ev<{ exitCode?: number }>(`demo.exec(${JSON.stringify(`node -e 'const f="creature/robot.json"; const s=JSON.parse(require("fs").readFileSync(f,"utf8")); s.look.torso="blue"; s.name="Offline"; s.edits++; require("fs").writeFileSync(f, JSON.stringify(s));'`)})`);
  await ev("demo.flush()");
  await until(`document.getElementById("creature").contentWindow.__walks.look().torso === "#3b78d9"`, 40_000).catch(() => undefined);
  ok("offline: an edit of the robot's file redraws the creature (the torso is blue)", (await walks<{ torso: string }>("w.look()")).torso === "#3b78d9", { edited, look: await walks("w.look()") });
  ok("offline: the creature is still simulating", await walks<boolean>("w.app.sim.time > 1"));
  await page.screenshot(join(shots, "pane-3-offline.png"));

  // a reload with no network: same robot
  await page.send("Page.reload");
  await sleep(1500);
  await page.until("globalThis.demo && demo.state.mode === 'offline'", 300_000, 500);
  await until(`!!document.getElementById("creature").contentWindow?.__walks`, 120_000);
  await until(`document.getElementById("creature").contentWindow.__walks.look().torso === "#3b78d9"`, 60_000).catch(() => undefined);
  ok("offline reload: the creature page loads from the cache and the robot is the one the agent made", (await walks<{ torso: string; legs: string[] }>("w.look()")).torso === "#3b78d9" && (await walks<{ legs: string[] }>("w.look()")).legs.every((c) => c === "#d9423b"), await walks("w.look()"));
  ok("offline reload: the body is the changed one, with its brain flagged", (await walks<string>("w.app.bodySha")) === changes && (await walks<boolean>("w.fits()")) === false, { sha: await walks("w.app.bodySha"), want: changes });
  await page.screenshot(join(shots, "pane-4-offline-reload.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, net: demo.net(), items: demo.items().slice(-4).map(i => ({ kind: i.kind, text: String(i.text ?? i.name ?? '').slice(0, 100) })), creature: document.getElementById('creature')?.contentWindow?.__walks?.state?.() }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-10).join("\n"));
    await page.screenshot(join(shots, "pane-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
