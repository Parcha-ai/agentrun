// A skill that passed on the trainer, played by the real page: D2's spin-trace files (a dino body, spin and walk policies, skills.json) are put in a run's work folder,
// the agent's page opens (robot=1), `do` picks the skill through the agent's tool, and the creature's yaw rate is read off the simulation. It answers "spin passed at
// checkpoint 5 but did not spin in the tab": does the page select the policy, does it fit the body, does the creature turn at the rate the trainer measured.
//   REBUILT=1 rebuilds body.xml after the training (other bytes, same body): the page borrows the policies and says it stumbles, and they still run.
//   TRACE=<folder with robot/ and home/> [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/spin-trace-check.ts
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
if (!trace || !existsSync(join(trace, "home/skills.json")) || !existsSync(join(trace, "robot/body.xml"))) throw new Error("TRACE must name a folder with robot/body.xml, robot/body.json and home/skills.json, home/skills/*.json");
dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "spin-trace-"));
const port = await freePort();
const RUN = "st";
const work = join(dir, "runs", RUN, "work");
mkdirSync(join(work, "home/skills"), { recursive: true });
mkdirSync(join(work, "robot"), { recursive: true });
for (const f of ["robot/body.xml", "home/skills.json"]) copyFileSync(join(trace, f), join(work, f));
// robot/body.json is the page's pairing file for a body written as code (name, tag_list, xml_sha256 of body.xml). A folder from the trainer holds the trainer's own body.json (the creature's
// description: legs, jointNames, standPose); the page cannot pair that, so a code body.json for the same body.xml is made here (its tags are not what is under test).
const code = JSON.parse(readFileSync(join(trace, "robot/body.json"), "utf8")) as { tag_list?: unknown; xml_sha256?: string; jointNames?: string[]; standPose?: number[]; standHeight?: number };
const xmlBytes = readFileSync(join(trace, "robot/body.xml"));
const xmlSha = createHash("sha256").update(xmlBytes).digest("hex");
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
const skillsHome = JSON.parse(readFileSync(join(trace, "home/skills.json"), "utf8")) as { skills: Record<string, { policy: string; command: number }> };
for (const e of Object.values(skillsHome.skills)) copyFileSync(join(trace, "home", e.policy), join(work, "home", e.policy));
server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/files/", "--no-restore", "home/model/"], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server!.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
devices = device;
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1&brain=off#"));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await page.until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000, 300);
  await page.until(`(() => { const w = document.getElementById("creature").contentWindow.__walks; return w.app.built.code === true && Object.keys(w.skills().skills ?? {}).length > 0; })()`, 90_000, 300);
  const first = await walks<{ skills: string[]; skill: string | undefined; fits: boolean; sha: string }>(`({ skills: Object.keys(w.skills().skills ?? {}), skill: w.skill(), fits: w.fits(), sha: w.app.bodySha })`);
  console.log(`  page: ${JSON.stringify(first)}`);
  const policySha = (JSON.parse(readFileSync(join(trace, "home", Object.values(skillsHome.skills)[0]!.policy), "utf8")) as { mjcf_sha256: string }).mjcf_sha256;
  ok("the policies were trained on this body.xml (sha256 of the file = their mjcf_sha256)", xmlSha === policySha, { xmlSha, policySha });
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
  // A policy on the older single-policy paths lands while a skill the agent chose is running: the trainer's final policy (home/policy.json) and the live checkpoint stream (train/gpu/policy.json). The agent's choice stands:
  // the page keeps the skill it was asked for and turns at its rate, and says the arrival was held.
  if (names.includes("spin")) {
    await ev(`demo.stubCloud([{ call: { name: "do", arguments: { skill: "spin" } } }, { text: "Done." }])`);
    await say("do spin");
    await page.until(`document.getElementById("creature").contentWindow.__walks.skill() === "spin"`, 30_000, 300).catch(() => undefined);
    await sleep(3000);
    await ev(`window.__held = []; window.addEventListener("walkshome:policy-held", (e) => window.__held.push(e.detail)); true`);
    for (const [path, which] of [["home/policy.json", "walk"], ["train/gpu/policy.json", "walk"]] as const) {
      const at = process.env.DEAD_WATCHER === "1" ? `${path}.unwatched` : path; // DEAD_WATCHER=1: the file lands where no watcher reads (a check that this test fails when the watcher does not see it)
      mkdirSync(join(work, at, ".."), { recursive: true });
      const text = JSON.parse(readFileSync(join(trace, "home", skillsHome.skills[which]!.policy), "utf8")) as Record<string, unknown>;
      writeFileSync(join(work, at), JSON.stringify({ ...text, note: `arrival at ${path}` }));
      // the page polls at 1 Hz: it must SAY it held this arrival (a watcher that never read the file holds nothing, and spin would simply have kept running)
      const held = await page.until(`window.__held.some((h) => h.name === ${JSON.stringify(path)} && h.skill === "spin")`, 20_000, 300).then(() => true, () => false);
      ok(`the page saw the policy that landed at ${path} and held it: a policy-held event names the path and the skill it kept`, held, await ev("window.__held"));
      const r = await yawRate(6);
      console.log(`  after ${path} landed: ${JSON.stringify(r)}`);
      ok(`a policy that lands at ${path} while spin is chosen does not end spin: the page still plays it, turning at at least 1 rad/s`, r.skill === "spin" && Math.abs(r.rate) >= 1.0, r);
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
