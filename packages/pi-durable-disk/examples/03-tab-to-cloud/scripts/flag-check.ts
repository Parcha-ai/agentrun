// The flag beat, in real Chrome: the robot stands in a place with a goal (a flag in the accent orange a few metres ahead), "walk to the flag" before any skill is home makes it try and fail, and once
// the skills are home a learned walk takes it to the flag. Each request reaches the creature page as creature/robot.json's `attempt` ({id, skill, learned}, written by the agent's `do`); the page
// answers it once in creature/attempt.json, which `do` reads back, and says where the flag is in creature/scene.json.
//   TRACE=<folder>  a code-mode run's snapshot: robot/body.xml + home/skills.json + home/skills/*.json. The skills are held back until step 3, as if the cluster brought them home then.
//   TOOL=1          ask through the agent's own `do` (a scripted cloud model calls it) instead of writing the request into creature/robot.json the way `do` does
//   CREATURE_DIR=<dir>  a built creature page to serve instead of 04's tab/dist (an older build, for a before and after)
//   [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] [VIEW=1440x900] node scripts/flag-check.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
type Dev = Awaited<ReturnType<Cdp["device"]>>;
let page: Awaited<ReturnType<Dev["open"]>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
const walks = <T>(expr: string) => ev<T>(`(() => { const w = document.getElementById("creature").contentWindow.__walks; return ${expr}; })()`);
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
type Item = { kind: string; name?: string; status?: string; output?: string; text?: string; details?: Record<string, unknown> };
const say = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(2500);
  await page!.until(idle, 120_000, 1000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
/** A file in the page's workspace, read in the page's own computer; null when it is not there. */
const readJson = async <T>(path: string): Promise<T | null> => {
  const r = await ev<{ output?: string }>(`demo.exec(${JSON.stringify(`cat ${path} 2>/dev/null || true`)})`);
  try { return JSON.parse(r.output ?? "") as T; } catch { return null; }
};
interface Scene { version: number; flag: { x: number; y: number; radius: number } }
interface Attempt { version: number; id: string; skill: string; learned: boolean; fell: boolean; distance_m: number; to_flag_m: number; reached_flag: boolean; started_at_flag: boolean; seconds: number }
/** Wait for the page's answer to request `id` (creature/attempt.json), up to `ms`. */
const answer = async (id: string, ms: number): Promise<{ attempt: Attempt | null; waitedMs: number }> => {
  const t0 = Date.now();
  for (;;) {
    const a = await readJson<Attempt>("creature/attempt.json");
    if (a?.id === id) return { attempt: a, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { attempt: null, waitedMs: Date.now() - t0 };
    await sleep(250);
  }
};
const torso = () => walks<{ x: number; y: number; up: number; t: number; skill: string | null }>("(() => { const [x, y] = w.app.sim.torsoPos(); return { x, y, up: w.app.sim.uprightness(), t: w.app.sim.time, skill: w.skill() ?? null }; })()");
const joints = () => walks<number[]>("Array.from(w.app.sim.data.qpos.slice(7))");

const here = import.meta.dirname;
let dir: string | undefined;
let server: ChildProcess | undefined;
let cdp: Cdp | undefined;
let devices: Dev | undefined;
let n = 0;
// everything that starts something is inside the try: a failed setup still stops the server and removes the folder
try {
  const trace = process.env.TRACE;
  if (!trace || !existsSync(join(trace, "home/skills.json")) || !existsSync(join(trace, "robot/body.xml"))) throw new Error("TRACE must name a code-mode run's folder: robot/body.xml, home/skills.json and home/skills/*.json");
  const tool = process.env.TOOL === "1";
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "flag-check-"));
  const port = await freePort();
  const RUN = "fc";
  const work = join(dir, "runs", RUN, "work");
  mkdirSync(join(work, "robot"), { recursive: true });
  mkdirSync(join(work, "held/skills"), { recursive: true });
  copyFileSync(join(trace, "robot/body.xml"), join(work, "robot/body.xml"));
  // the page's pairing file for a body written as code (as in spin-trace-check: a trainer's own body.json describes the creature, the page needs name, tags and the xml's sha)
  const code = JSON.parse(readFileSync(join(trace, "robot/body.json"), "utf8")) as { tag_list?: unknown; xml_sha256?: string; jointNames?: string[]; standPose?: number[]; standHeight?: number };
  const xmlSha = createHash("sha256").update(readFileSync(join(trace, "robot/body.xml"))).digest("hex");
  writeFileSync(join(work, "robot/body.json"), JSON.stringify(Array.isArray(code.tag_list) && code.xml_sha256 === xmlSha ? code : {
    name: "dino", motors: code.jointNames, joints: (code.jointNames ?? []).map((name, i) => ({ name, body: "", axis: [0, 1, 0], range: [-1, 1], stand: code.standPose?.[i] ?? 0, passive: false })), tags: {}, colors: {}, face: { tag: "head" }, warnings: [],
    legs: 4, tag_list: ["torso", "legs"], pieces: 32, mass_kg: 11, stand_height_m: code.standHeight, xml_sha256: xmlSha,
  }));
  // the skills wait outside home/ until step 3
  copyFileSync(join(trace, "home/skills.json"), join(work, "held/skills.json"));
  const manifest = JSON.parse(readFileSync(join(trace, "home/skills.json"), "utf8")) as { default?: string; skills: Record<string, { policy: string; command: number }> };
  for (const e of Object.values(manifest.skills)) copyFileSync(join(trace, "home", e.policy), join(work, "held", e.policy));
  if (!manifest.skills.walk) throw new Error("the folder's skills have no walk");
  // a sprint, when the folder has none (without TOOL=1): the walk's own network with a sprint's command range, which does not reach 0 (step 6: it must stop all the same when its run is over)
  if (!tool && !manifest.skills.sprint) {
    const walkFile = JSON.parse(readFileSync(join(trace, "home", manifest.skills.walk.policy), "utf8")) as Record<string, unknown>;
    writeFileSync(join(work, "held/skills/sprint.json"), JSON.stringify({ ...walkFile, command_range: [1.0, 1.4] }));
    manifest.skills.sprint = { policy: "skills/sprint.json", command: 1.0 };
    writeFileSync(join(work, "held/skills.json"), JSON.stringify({ ...manifest, skills: { ...manifest.skills, sprint: { policy: "skills/sprint.json", command: 1.0, label: "sprint" } } }));
  }
  server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/files/", "--no-restore", "home/model/", ...(process.env.CREATURE_DIR ? ["--creature-dir", process.env.CREATURE_DIR] : [])], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let link = "";
  server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
  for (let i = 0; i < 100 && !link; i++) await sleep(100);
  if (!link) throw new Error("the server printed no run link");
  cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
  devices = await cdp.device();
  const [vw, vh] = (process.env.VIEW ?? "1440x900").split("x").map(Number);
  page = await devices.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1&brain=off#"), { width: vw!, height: vh! });
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await page.until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000, 300);
  await page.until(`document.getElementById("creature").contentWindow.__walks.app.built.code === true`, 90_000, 300);
  await ev(`window.__flagEvents = []; for (const t of ["tried", "reached-flag"]) window.addEventListener("walkshome:" + t, (e) => window.__flagEvents.push({ type: t, ...e.detail })); true`);
  await sleep(1500);

  // 1. the place and the goal: the page says where the flag is, and the camera has the robot and the flag in the pane
  let scene: Scene | null = null;
  for (let i = 0; i < 40 && !scene; i++) { scene = await readJson<Scene>("creature/scene.json"); if (!scene) await sleep(250); }
  ok("the creature page wrote creature/scene.json: a flag 2.5 to 3.5 m ahead (+x), with a reach radius of 0.2 to 0.8 m", !!scene && scene.flag.x >= 2.5 && scene.flag.x <= 3.5 && scene.flag.radius >= 0.2 && scene.flag.radius <= 0.8, scene);
  const frame = await walks<{ robot: number[]; flag: number[] } | null>("w.app.view.framing?.() ?? null");
  const inside = (p?: number[]) => !!p && Math.abs(p[0]!) < 0.95 && Math.abs(p[1]!) < 0.95;
  ok("the robot and the flag are both in the pane at the start (screen positions within ±0.95)", !!frame && inside(frame.robot) && inside(frame.flag), frame);
  await page.screenshot(join(shots, "flag-1-start.png"));

  /**
   * The request as the agent's `do` makes it: through the tool (TOOL=1), or by writing robot.json's attempt the way the tool does. Returns once the request is in robot.json, with its id and the
   * turn (TOOL=1: the tool holds the turn until the page answers, so what the tool said comes when the turn ends).
   */
  const ask = async (skill: string, learned: boolean): Promise<{ id: string; turn: Promise<Item | undefined> }> => {
    if (tool) {
      const was = (await readJson<{ attempt?: { id: string } }>("creature/robot.json"))?.attempt?.id;
      await ev(`demo.stubCloud([{ call: { name: "do", arguments: { skill: ${JSON.stringify(skill)} } } }, { text: "Done." }])`);
      const turn = say(`do ${skill}`).then((items) => items.find((i) => i.kind === "tool" && i.name === "do"));
      let id: string | undefined;
      for (let i = 0; i < 120 && (!id || id === was); i++) { await sleep(250); id = (await readJson<{ attempt?: { id: string } }>("creature/robot.json"))?.attempt?.id; }
      if (!id || id === was) throw new Error(`do ${skill} wrote no new request into creature/robot.json (the id is still ${JSON.stringify(was)}): each request needs an id of its own`);
      return { id, turn };
    }
    const id = `check-${++n}`;
    const patch = `const fs = require("fs"); const f = "creature/robot.json"; const r = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; if (!r) process.exit(3); r.attempt = ${JSON.stringify({ id, skill, learned })}; ${learned ? `r.skill = ${JSON.stringify(skill)};` : ""} fs.writeFileSync(f, JSON.stringify(r, null, 1) + "\\n");`;
    const r = await ev<{ exitCode?: number; output?: string }>(`demo.exec(${JSON.stringify(`node -e '${patch}'`)})`);
    if (r.exitCode !== 0) throw new Error(`could not write the request into creature/robot.json: ${JSON.stringify(r).slice(0, 300)}`);
    return { id, turn: Promise.resolve(undefined) };
  };
  /** A skill with no request, as `do` asks for any skill but walk and sprint: through the tool (TOOL=1), or robot.json's skill. */
  const playSkill = async (skill: string) => {
    if (tool) { await ev(`demo.stubCloud([{ call: { name: "do", arguments: { skill: ${JSON.stringify(skill)} } } }, { text: "Done." }])`); await say(`do ${skill}`); return; }
    const set = `const fs = require("fs"); const f = "creature/robot.json"; const r = JSON.parse(fs.readFileSync(f, "utf8")); r.skill = ${JSON.stringify(skill)}; fs.writeFileSync(f, JSON.stringify(r, null, 1) + "\\n");`;
    await ev(`demo.exec(${JSON.stringify(`node -e '${set}'`)})`);
  };
  const other = Object.keys(manifest.skills).find((s) => s !== "walk" && s !== "sprint");
  const late = Object.keys(manifest.skills).find((s) => s !== "walk" && s !== "sprint" && s !== other); // a skill whose policy lands late (step 3c)
  const answerFor = async (id: string) => { const a = await readJson<Attempt>("creature/attempt.json"); return a?.id === id ? a : null; };
  // a robot.json to write the request into: a real robot tool makes it (code mode has none until the agent edits the robot)
  if (!tool) { await ev(`demo.stubCloud([{ call: { name: "rename", arguments: { name: "Rex" } } }, { text: "Done." }])`); await say("call it Rex"); }

  // 2. no skill is home: the robot tries and fails, and is put back where it stood
  const before = await torso();
  const q0 = await joints();
  const tryAsk = await ask("walk", false);
  await page.until(`document.getElementById("creature").contentWindow.__walks.trying()`, 10_000, 100).catch(() => undefined);
  await sleep(3000);
  const mid = await torso();
  const q1 = await joints();
  await page.screenshot(join(shots, "flag-2-try.png"));
  const moved = Math.max(...q1.map((v, i) => Math.abs(v - (q0[i] ?? 0))));
  ok("during the try its joints move (largest change from the standing pose at least 0.2 rad, about 3 s in)", moved >= 0.2, { moved, mid });
  const tried = await answer(tryAsk.id, 8000);
  console.log(`  the try: ${JSON.stringify(tried)}`);
  ok("the page answered the try in creature/attempt.json within 8 s: not learned, about 4 s, the flag not reached", !!tried.attempt && tried.attempt.learned === false && tried.attempt.skill === "walk" && !tried.attempt.reached_flag && tried.attempt.seconds >= 3.5 && tried.attempt.seconds <= 5 && typeof tried.attempt.fell === "boolean", tried);
  ok("a tried event reached the agent's page", await ev<boolean>(`window.__flagEvents.some((e) => e.type === "tried")`), await ev("window.__flagEvents"));
  if (tool) {
    const said = await tryAsk.turn;
    console.log(`  do walk (nothing home): ${said?.output?.slice(0, 300)}`);
    const a = said?.details?.attempt as Attempt | undefined;
    ok("the agent's do reports the try, typed: a try, carrying the page's answer for this request", said?.details?.kind === "try" && a?.id === tryAsk.id && a.learned === false && a.fell === tried.attempt?.fell, said?.details);
  }
  await sleep(2500);
  const after = await torso();
  ok("after the try the robot stands again where it stood (within 2 cm, upright)", Math.hypot(after.x - before.x, after.y - before.y) < 0.02 && after.up > 0.95, { before, after });

  // 3. the skills come home: with a flag to walk to, the robot waits for the request instead of walking off on its own. Without TOOL=1 the walk's own policy file stays out until step 4 (a request
  //    that comes before its policy has landed); the tool reads the policies, so with TOOL=1 they all come home now.
  const holdBack = tool ? [] : ["walk", ...(late ? [late] : [])].map((k) => `held/${manifest.skills[k]!.policy}`);
  await ev(`demo.exec(${JSON.stringify(`mkdir -p home/skills && cp held/skills.json home/skills.json && for f in held/skills/*.json; do case " ${holdBack.join(" ")} " in *" $f "*) ;; *) cp "$f" home/skills/;; esac; done`)})`);
  await page.until(`Object.keys(document.getElementById("creature").contentWindow.__walks.skills()?.skills ?? {}).length > 0`, 30_000, 300);
  const home0 = await torso();
  await sleep(4000);
  const home1 = await torso();
  ok("the skills are home and the robot waits: no skill playing, it has not moved (under 5 cm in 4 s)", home1.skill === null && Math.hypot(home1.x - home0.x, home1.y - home0.y) < 0.05, { home0, home1 });

  // 3b. another skill asked for during an untrained try: the try is answered as it stood, the robot put back, and that skill plays at once (not after the try's window)
  if (!tool && other) {
    const cut = await ask("walk", false);
    await page.until(`document.getElementById("creature").contentWindow.__walks.trying()`, 10_000, 100).catch(() => undefined);
    await sleep(1000);
    await playSkill(other);
    const playing = await page.until(`document.getElementById("creature").contentWindow.__walks.skill() === ${JSON.stringify(other)} && !document.getElementById("creature").contentWindow.__walks.trying()`, 4_000, 100).then(() => true, () => false);
    const cutAnswer = await answerFor(cut.id);
    ok(`${other} asked for during a try plays within 4 s, and the try is answered cut short (under 3.5 s)`, playing && !!cutAnswer && cutAnswer.seconds < 3.5 && cutAnswer.learned === false, { playing, skill: await walks("w.skill()"), trying: await walks("w.trying()"), cutAnswer });
  }

  // 3c. a request waiting for its skill's policy is dropped when robot.json names another skill: the policy landing later does not bring the old request back over the newer choice
  if (!tool && other && late) {
    const stale = await ask(late, true);
    await sleep(2500);
    await playSkill(other);
    await sleep(2000);
    await ev(`demo.exec(${JSON.stringify(`cp held/${manifest.skills[late]!.policy} home/${manifest.skills[late]!.policy}`)})`);
    await sleep(3500);
    const kept = { skill: await walks<string | null>("w.skill() ?? null"), attempt: await walks("w.attempt()"), answer: await answerFor(stale.id) };
    ok(`a ${late} request waiting for its policy, then ${other}: when ${late}'s policy lands ${other} keeps playing and the old request does not start`, kept.skill === other && kept.attempt === null && !kept.answer, kept);
  }

  // 4. the learned walk: it reaches the flag, the flag has its moment, the page says so
  const walkAsk = await ask("walk", true);
  if (!tool) {
    await sleep(2500);
    const waiting = { answer: await answerFor(walkAsk.id), skill: await walks<string | null>("w.skill() ?? null") };
    ok("a learned walk asked for before its policy has landed waits for it: not answered, not playing", !waiting.answer && waiting.skill !== "walk", waiting);
    await ev(`demo.exec("cp held/skills/walk.json home/skills/walk.json")`);
  }
  await sleep(4000);
  await page.screenshot(join(shots, "flag-3-walking.png"));
  const walked = await answer(walkAsk.id, 24000);
  console.log(`  the walk: ${JSON.stringify(walked)}`);
  ok("the page answered the walk within 24 s: learned, the flag reached in under 15 s, standing", !!walked.attempt && walked.attempt.learned && walked.attempt.reached_flag && walked.attempt.seconds < 15 && !walked.attempt.fell, walked);
  ok("a reached-flag event reached the agent's page", await ev<boolean>(`window.__flagEvents.some((e) => e.type === "reached-flag")`), await ev("window.__flagEvents"));
  if (tool) {
    const said = await walkAsk.turn;
    console.log(`  do walk (learned): ${said?.output?.slice(0, 300)}`);
    const a = said?.details?.attempt as Attempt | undefined;
    ok("the agent's do reports the walk, typed: a skill, carrying the page's answer for this request, the flag reached", said?.details?.kind === "skill" && a?.id === walkAsk.id && a.learned === true && a.reached_flag === true, said?.details);
  }
  ok("the flag has its moment", (await walks<string | null>("w.app.view.flagState?.() ?? null")) === "reached");
  await sleep(1500);
  await page.screenshot(join(shots, "flag-4-reached.png"));
  const atFlag = await torso();
  ok("the robot is at the flag", !!scene && Math.hypot(atFlag.x - scene.flag.x, atFlag.y - scene.flag.y) < scene.flag.radius + 0.5, { atFlag, flag: scene?.flag });
  await sleep(3000);
  const stood = await torso();
  ok("and it stops there: under 15 cm in the next 3 s, upright", Math.hypot(stood.x - atFlag.x, stood.y - atFlag.y) < 0.15 && stood.up > 0.9, { atFlag, stood });

  // 4b. the pane reloads after the walk was answered: robot.json still names walk and its request, and the robot stands (a walk started again would have nothing measuring or stopping it)
  await ev(`(document.getElementById("creature").contentWindow.location.reload(), true)`);
  await sleep(1500);
  await page.until(`(() => { const w = document.getElementById("creature").contentWindow.__walks; return !!w && w.app.built?.code === true && Object.keys(w.skills()?.skills ?? {}).length > 0; })()`, 90_000, 300);
  await sleep(3000); // robot.json is read within a second
  const r0 = await torso();
  await sleep(3000);
  const r1 = await torso();
  ok("after a reload the answered walk does not start again: no skill playing, it stands (under 5 cm in 3 s)", r1.skill === null && Math.hypot(r1.x - r0.x, r1.y - r0.y) < 0.05, { r0, r1 });

  // 5. any other learned skill is a plain skill change (the agent's do writes no request for it): it plays where the robot stands, and nothing is answered for it
  if (other) {
    const was = await torso();
    await playSkill(other);
    await page.until(`document.getElementById("creature").contentWindow.__walks.skill() === ${JSON.stringify(other)}`, 15_000, 250).catch(() => undefined);
    await sleep(3000);
    const now = await torso();
    const last = await readJson<Attempt>("creature/attempt.json");
    ok(`${other} plays where the robot stands: not put back at the start, and the last answer is still the walk's`, now.skill === other && Math.hypot(now.x - was.x, now.y - was.y) < 0.6 && last?.id === walkAsk.id, { was, now, last: last?.id });
  }
  // 5b. another skill asked for during a learned walk's run: the run is answered when it takes over (its moves are not the walk's), and that skill keeps its own command
  if (!tool && other) {
    const cutWalk = await ask("walk", true);
    await page.until(`document.getElementById("creature").contentWindow.__walks.attempt()?.id === ${JSON.stringify(cutWalk.id)}`, 10_000, 100).catch(() => undefined);
    await sleep(1000);
    await playSkill(other);
    await page.until(`document.getElementById("creature").contentWindow.__walks.skill() === ${JSON.stringify(other)}`, 10_000, 100).catch(() => undefined);
    await sleep(400);
    const cutRun = await answerFor(cutWalk.id);
    const after = { attempt: await walks("w.attempt()"), command: await walks<number>("w.app.sim.command") };
    ok(`${other} asked for during the walk's run: the run is answered as ${other} takes over, and ${other} plays at its own command`, !!cutRun && cutRun.learned && !cutRun.reached_flag && after.attempt === null && Math.abs(after.command - manifest.skills[other]!.command) < 1e-9, { cutRun, after });
  }
  // 6. a forward skill whose policy's command range does not reach 0 (a sprint, [1.0, 1.4]) stops too once its run is answered: there, short of it, or fallen
  if (!tool && manifest.skills.sprint) {
    const sprintAsk = await ask("sprint", true);
    const sprinted = await answer(sprintAsk.id, 24000);
    await sleep(2000); // it comes to rest
    const s0 = await torso();
    await sleep(3000);
    const s1 = await torso();
    ok("a sprint's run is answered, and then it stops though its command range does not reach 0: no skill playing, under 15 cm in 3 s", !!sprinted.attempt && sprinted.attempt.learned && s1.skill === null && Math.hypot(s1.x - s0.x, s1.y - s0.y) < 0.15, { sprinted: sprinted.attempt, s0, s1 });
  }
  // 7. the body is rebuilt in the moment the robot settles after a run (a new simulation, its clock from 0): the new body stands still at once, as with no skill playing
  if (!tool && manifest.skills.sprint) {
    const again = await ask("sprint", true);
    const done = await answer(again.id, 24000);
    await walks(`(w.buildCreature(w.app.sketcher.get(), true, { built: w.app.built }), true)`);
    await sleep(600);
    const t0 = await walks<number>("w.app.sim.time");
    await sleep(1500);
    const t1 = await walks<number>("w.app.sim.time");
    ok("a body rebuilt as the robot settles after a run stands still: its new simulation does not run on (under 0.1 s of simulated time in 1.5 s)", !!done.attempt && t1 - t0 < 0.1, { answered: !!done.attempt, t0, t1 });
  }
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, items: demo.items().slice(-4) }) : null)()").catch(() => null)).slice(0, 1500));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-14).join("\n"));
    await page.screenshot(join(shots, "flag-failed.png")).catch(() => undefined);
  }
} finally {
  await devices?.close().catch(() => undefined);
  cdp?.close();
  // the server writes into the run's folder until it exits: the folder goes after it
  if (server && server.exitCode === null) { const exited = new Promise((r) => server!.once("exit", r)); server.kill("SIGKILL"); await exited; }
  if (dir && process.env.KEEP !== "1") rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? `${failed} FAILED` : "all ok");
process.exit(failed ? 1 : 0);
