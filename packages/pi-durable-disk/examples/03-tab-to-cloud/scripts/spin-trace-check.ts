// A skill that passed on the trainer, played by the real page. A trace folder from a run (a snapshot of its disk) is put in a run's work folder, the agent's page opens (robot=1), `do` picks each
// skill through the agent's tool, and the creature's yaw rate is read off the simulation. It answers "spin passed at checkpoint 5 but did not spin in the tab": does the page select the policy, does
// it fit the body, does the creature turn at the rate the trainer measured, and does it spin when it was lying down where spin was asked for (none of a round's policies has a get-up network).
//   TRACE=<folder>  one of: robot/body.xml + home/ (code mode); robot/body.mjs + home/ (built here, in the page's computer, never on this host); creature/robot.json + home/ (the preset flow)
//   REBUILT=1       rebuilds body.xml after the training (other bytes, same body): the page borrows the policies and says it stumbles, and they still run.
//   [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/spin-trace-check.ts
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
type Item = { kind: string; name?: string; status?: string; output?: string; text?: string };
const say = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(2500);
  await page!.until(idle, 120_000, 1000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
/** Mean yaw rate over `seconds` of simulated time, from the free joint's quaternion (unwrapped between samples), and whether the torso stayed up. */
const withTimeout = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => new Promise<T>((resolve, reject) => { const t = setTimeout(() => reject(new Error(`${what} did not finish in ${Math.round(ms / 1000)} s`)), ms); work.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
/** Mean yaw rate over `seconds` of simulated time, from the free joint's quaternion (unwrapped between samples), and whether the torso stayed up. A simulation that stops stepping, or is replaced, fails by name. */
const yawRate = (seconds: number) => withTimeout(walks<{ rate: number; up: number; skill: string | undefined; simSeconds: number }>(`(async () => { const sim = w.app.sim; const yaw = () => { const q = sim.data.qpos; return Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6])); }; let last = yaw(), total = 0; const t0 = sim.time; const stop = Date.now() + ${seconds * 8 + 20} * 1000; while (sim.time - t0 < ${seconds}) { await new Promise((r) => setTimeout(r, 100)); if (w.app.sim !== sim) throw new Error("the simulation was replaced while it was measured"); if (Date.now() > stop) throw new Error("the simulation stopped stepping: " + (sim.time - t0).toFixed(2) + " s of ${seconds} s after ${seconds * 8 + 20} s"); const y = yaw(); let d = y - last; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; total += d; last = y; } return { rate: total / (sim.time - t0), up: sim.uprightness(), skill: w.skill(), simSeconds: sim.time - t0 }; })()`), (seconds * 8 + 40) * 1000, "the yaw-rate measurement");

const here = import.meta.dirname;
let dir: string | undefined;
let server: ChildProcess | undefined;
let cdp: Cdp | undefined;
let devices: Awaited<ReturnType<Cdp["device"]>> | undefined;
// everything that starts something is inside the try: a failed setup (no Chrome at CDP, no run link) still stops the server and removes the folder, and only what was started
try {
const trace = process.env.TRACE;
// A folder of a run in code mode has robot/body.xml (and the trainer's robot/body.json); a run of the preset flow has creature/robot.json (the robot's design) and its body is the preset's.
// A code-mode snapshot that kept robot/body.mjs but not the built body.xml is built here the way the agent builds it, with `node robot/build.mjs` in the page's own computer (never on this host).
const fromSource = !!trace && !existsSync(join(trace, "robot/body.xml")) && existsSync(join(trace, "robot/body.mjs"));
const preset = !!trace && !fromSource && !existsSync(join(trace, "robot/body.xml")) && existsSync(join(trace, "creature/robot.json"));
if (!trace || !existsSync(join(trace, "home/skills.json")) || (!preset && !fromSource && !existsSync(join(trace, "robot/body.xml")))) throw new Error("TRACE must name a folder with home/skills.json and home/skills/*.json, and robot/body.xml (code mode), robot/body.mjs (code mode, built here) or creature/robot.json (the preset flow)");
dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "spin-trace-"));
const port = await freePort();
const RUN = "st";
const work = join(dir, "runs", RUN, "work");
mkdirSync(join(work, "home/skills"), { recursive: true });
if (process.env.REBUILT === "1" && (fromSource || preset)) throw new Error("REBUILT=1 rebuilds the body.xml of a code-mode folder that has one; this folder is " + (preset ? "a preset-flow snapshot (no body.xml)" : "built here from body.mjs (the build is the rebuild)") + ", so there is nothing to rebuild");
let xmlSha = "";
if (fromSource) {
  mkdirSync(join(work, "robot"), { recursive: true });
  copyFileSync(join(trace, "robot/body.mjs"), join(work, "robot/body.mjs"));
  copyFileSync(join(trace, "home/skills.json"), join(work, "home/skills.json"));
} else if (preset) {
  mkdirSync(join(work, "creature"), { recursive: true });
  copyFileSync(join(trace, "creature/robot.json"), join(work, "creature/robot.json"));
  copyFileSync(join(trace, "home/skills.json"), join(work, "home/skills.json"));
} else {
  mkdirSync(join(work, "robot"), { recursive: true });
  for (const f of ["robot/body.xml", "home/skills.json"]) copyFileSync(join(trace, f), join(work, f));
  // robot/body.json is the page's pairing file for a body written as code (name, tag_list, xml_sha256 of body.xml). A folder from the trainer holds the trainer's own body.json (the creature's
  // description: legs, jointNames, standPose); the page cannot pair that, so a code body.json for the same body.xml is made here (its tags are not what is under test).
  const code = JSON.parse(readFileSync(join(trace, "robot/body.json"), "utf8")) as { tag_list?: unknown; xml_sha256?: string; jointNames?: string[]; standPose?: number[]; standHeight?: number };
  const xmlBytes = readFileSync(join(trace, "robot/body.xml"));
  xmlSha = createHash("sha256").update(xmlBytes).digest("hex");
  const bodyJson = Array.isArray(code.tag_list) && code.xml_sha256 === xmlSha ? code : {
    name: "dino", motors: code.jointNames, joints: (code.jointNames ?? []).map((name, i) => ({ name, body: "", axis: [0, 1, 0], range: [-1, 1], stand: code.standPose?.[i] ?? 0, passive: false })), tags: {}, colors: {}, face: { tag: "head" }, warnings: [],
    legs: 4, tag_list: ["torso", "legs"], pieces: 32, mass_kg: 11, stand_height_m: code.standHeight, xml_sha256: xmlSha,
  };
  if (process.env.REBUILT === "1") {
    // a body.xml rebuilt after training (any helper change alters the bytes): other bytes, the same body; its body.json pairs with the new bytes
    const rebuilt = xmlBytes.toString("utf8").replace("<mujoco", "<!-- rebuilt -->\n<mujoco");
    writeFileSync(join(work, "robot/body.xml"), rebuilt);
    bodyJson.xml_sha256 = createHash("sha256").update(rebuilt).digest("hex");
  }
  writeFileSync(join(work, "robot/body.json"), JSON.stringify(bodyJson));

}
const skillsHome = JSON.parse(readFileSync(join(trace, "home/skills.json"), "utf8")) as { skills: Record<string, { policy: string; command: number }> };
for (const e of Object.values(skillsHome.skills)) copyFileSync(join(trace, "home", e.policy), join(work, "home", e.policy));
server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/files/", "--no-restore", "home/model/"], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server!.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
devices = device;
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", `?robot=1&brain=off${preset ? "&robotcode=0" : ""}#`));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await page.until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000, 300);
  if (fromSource) {
    // the page's computer builds the body from the snapshot's body.mjs (the helper files are seeded by the session), and the page compiles it
    const was = await walks<string>("w.app.bodySha");
    let built = "";
    for (let i = 0; i < 60 && !/wrote robot\/body\.xml/.test(built); i++) { built = (await ev<{ output?: string }>(`demo.exec("node robot/build.mjs")`).catch(() => ({ output: "" }))).output ?? ""; if (!/wrote robot\/body\.xml/.test(built)) await sleep(2000); }
    console.log(`  built in the page's computer: ${built.slice(0, 160)}`);
    await page.until(`document.getElementById("creature").contentWindow.__walks.app.bodySha !== ${JSON.stringify(was)}`, 60_000, 300);
  }
  await page.until(`(() => { const w = document.getElementById("creature").contentWindow.__walks; return (w.app.built.code === true || ${preset}) && Object.keys(w.skills().skills ?? {}).length > 0; })()`, 90_000, 300);
  if (preset) await page.until(`document.getElementById("creature").contentWindow.__walks.app.bodySha === ${JSON.stringify(JSON.parse(readFileSync(join(trace, "home", Object.values(skillsHome.skills)[0]!.policy), "utf8")).mjcf_sha256)}`, 60_000, 300).catch(() => undefined); // the robot's design is built from creature/robot.json a moment after the skills are known
  const first = await walks<{ skills: string[]; skill: string | undefined; fits: boolean; sha: string }>(`({ skills: Object.keys(w.skills().skills ?? {}), skill: w.skill(), fits: w.fits(), sha: w.app.bodySha })`);
  console.log(`  page: ${JSON.stringify(first)}`);
  const policySha = (JSON.parse(readFileSync(join(trace, "home", Object.values(skillsHome.skills)[0]!.policy), "utf8")) as { mjcf_sha256: string }).mjcf_sha256;
  if (!preset && !fromSource) ok("the policies were trained on this body.xml (sha256 of the file = their mjcf_sha256)", xmlSha === policySha, { xmlSha, policySha });
  if (process.env.REBUILT === "1") ok("a body.xml rebuilt after training is another body to the page: its sha is not the policies'", first.sha !== policySha, { page: first.sha, policy: policySha });
  else ok("the page's compiled body is the one the policies were trained on (sha256 of body.xml = the policy's mjcf_sha256)", first.sha === policySha, { page: first.sha, policy: policySha });
  ok("the skills came home to the page: the manifest's skills are the page's", Object.keys(skillsHome.skills).every((n) => JSON.stringify(first.skills).includes(n)), first.skills);
  // pick the skills with the agent's own tool, as a user's "make it spin" would
  const names = Object.keys(skillsHome.skills);
  for (const name of names.includes("spin") ? ["spin", ...names.filter((n) => n !== "spin")] : names) {
    await ev(`demo.stubCloud([{ call: { name: "do", arguments: { skill: ${JSON.stringify(name)} } } }, { text: "Done." }])`);
    const items = await say(`do ${name}`);
    const tool = items.find((i) => i.kind === "tool" && i.name === "do");
    console.log(`  do ${name}: ${tool?.status} ${tool?.output}`);
    await page.until(`document.getElementById("creature").contentWindow.__walks.skill() === ${JSON.stringify(name)}`, 30_000, 300).catch(() => undefined);
    await sleep(2000); // the page switches at its next control step, then the creature gets up or gets going
    const r = await yawRate(Number(process.env.SECONDS ?? 8));
    console.log(`  ${name}: ${JSON.stringify(r)}`);
    ok(`do ${name}: the tool accepted it and the page is playing ${name}`, tool?.status === "done" && r.skill === name, { tool, skill: r.skill });
    if (process.env.REBUILT === "1") ok(`do ${name}: the tool says the brain was taught for another body (the robot stumbles until retrained)`, /taught for another body/.test(tool?.output ?? ""), tool?.output);
    if (name === "spin") ok("spin turns the creature in the tab: its yaw rate is at least the trainer's target of 1.0 rad/s and it stays up", Math.abs(r.rate) >= 1.0 && r.up > 0.5, r);
    else ok(`${name} does not spin: yaw rate under 0.5 rad/s`, Math.abs(r.rate) < 0.5, r);
    if (name === "spin") await page.screenshot(join(shots, "spin-trace-spin.png"));
    // the selection stays: a later policy arrival must not end it
    await sleep(6000);
    ok(`${name} is still the page's skill six seconds later`, (await walks<string | undefined>("w.skill()")) === name);
  }
  // A creature that is lying down when it is asked for a skill. (A policy that arrives on the older single-policy paths replaces the skill by design: 04's check-robot asserts it.)
  if (names.includes("spin")) {
    await ev(`demo.stubCloud([{ call: { name: "do", arguments: { skill: "spin" } } }, { text: "Done." }])`);
    await say("do spin");
    await page.until(`document.getElementById("creature").contentWindow.__walks.skill() === "spin"`, 30_000, 300).catch(() => undefined);
    await sleep(3000);
    // A creature that is lying down when it is asked for a skill. The policies of a round carry no get-up network (a real round's skills here have none), so a creature that fell cannot rise by itself.
    // Two ways it is stood up, each seen on its own: choosing a skill stands it up at once (the page's stood-up event says reason "skill"), and a creature left lying is stood up after standAfterS (reason "fallen").
    await ev(`window.__stood = []; window.addEventListener("walkshome:stood-up", (e) => window.__stood.push({ ...e.detail, at: performance.now() })); true`);
    const shoveDown = async () => {
      for (let i = 0; i < 6; i++) { await walks(`w.kick([0, 1], ${400 + 300 * i})`); const down = await page!.until(`document.getElementById("creature").contentWindow.__walks.app.sim.uprightness() < 0.3`, 6_000, 100).then(() => true, () => false); if (down) return true; }
      return false;
    };
    const doSkill = async (name: string) => { await ev(`demo.stubCloud([{ call: { name: "do", arguments: { skill: ${JSON.stringify(name)} } } }, { text: "Done." }])`); await say(`do ${name}`); await page!.until(`document.getElementById("creature").contentWindow.__walks.skill() === ${JSON.stringify(name)}`, 30_000, 300).catch(() => undefined); };
    const hasGetup = (JSON.parse(readFileSync(join(trace, "home", skillsHome.skills.spin!.policy), "utf8")) as { getup?: unknown }).getup !== undefined;
    console.log(`  (the spin policy has ${hasGetup ? "a" : "no"} get-up network)`);
    // 1. the skill's own stand-up: the fall timer is set out of reach, so only choosing the skill can stand it up (it needs a second skill to switch from)
    const second = names.find((n) => n !== "spin");
    if (!second) console.log("  (this folder has only spin: the skill's own stand-up needs another skill to switch from, so only the timer is checked)");
    else {
      await doSkill(second);
      await walks("(w.app.standAfterS = 1e9, true)");
      await sleep(1500);
      ok("a shove puts the creature down (the fall timer is set out of reach)", await shoveDown(), await walks("({ up: w.app.sim.uprightness() })"));
      await ev("window.__stood.length = 0; true");
      await sleep(4000); // longer than the page's own 3 s: nothing may stand it up while the timer is out of reach
      ok("with the timer out of reach it lies where it fell, and nothing stood it up", (await walks<number>("w.app.sim.uprightness()")) < 0.3 && (await ev<number>("window.__stood.length")) === 0);
      await doSkill("spin");
      await page.until(`window.__stood.some((e) => e.reason === "skill" && e.skill === "spin")`, 10_000, 100).then(() => undefined, () => undefined);
      const stood = await ev<{ reason: string; skill?: string }[]>("window.__stood");
      ok("choosing spin stood the lying creature up: a stood-up event with reason skill names spin", stood.some((e) => e.reason === "skill" && e.skill === "spin"), stood);
      await sleep(2500);
      const up = await yawRate(6);
      console.log(`  spin asked for while it lay down: ${JSON.stringify(up)}`);
      ok("spin asked for while the creature lies down: it is on its feet and turns at at least 1 rad/s", up.up > 0.5 && Math.abs(up.rate) >= 1.0 && up.skill === "spin", up);
    }
    // 2. the timer: a creature left lying under a policy with no get-up network is set back on its feet after standAfterS
    await walks("(w.app.standAfterS = 3, true)");
    await ev("window.__stood.length = 0; true");
    ok("a shove puts the spinning creature down again", await shoveDown(), await walks("({ up: w.app.sim.uprightness() })"));
    await page.until(`window.__stood.some((e) => e.reason === "fallen") || document.getElementById("creature").contentWindow.__walks.app.sim.uprightness() > 0.8`, 20_000, 200).then(() => undefined, () => undefined);
    const timer = await ev<{ reason: string }[]>("window.__stood");
    const risen = await walks<number>("w.app.sim.uprightness()");
    if (timer.length === 0 && risen > 0.8) console.log("  (this policy got up by itself within the delay, so the page's fall timer was not needed; only a policy that stays down shows it)");
    else {
      ok("left lying, it is stood up by the page after a few seconds: a stood-up event with reason fallen", timer.some((e) => e.reason === "fallen"), timer);
      await sleep(2500);
      const again = await yawRate(6);
      ok("and it spins again", again.up > 0.5 && Math.abs(again.rate) >= 1.0, again);
    }
  }
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, items: demo.items().slice(-4) }) : null)()").catch(() => null)).slice(0, 1500));
    console.log(JSON.stringify(await walks("({ code: w.app.built?.code, sha: w.app.bodySha, skills: w.skills(), skill: w.skill(), fits: w.fits(), status: document.getElementById('status')?.textContent })").catch((e) => String(e))).slice(0, 1200));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-14).join("\n"));
    await page.screenshot(join(shots, "spin-trace-failed.png")).catch(() => undefined);
  }
} finally {
  await devices?.close().catch(() => undefined);
  cdp?.close();
  server?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
