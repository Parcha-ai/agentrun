// The build_robot tool's work: put the helper files in the robot's workspace, and say what the creature page made of the body the agent built (`node robot/build.mjs` wrote robot/body.xml and robot/body.json; the page compiles
// the body in MuJoCo, holds its standing pose and writes robot/build.json with the same sha as the xml). Portable: no Node API; the computer, the clock and the hash come in.
import { ROBOT_TEMPLATES } from "./robot-templates.ts";

/** What the tool needs of the computer (the pi execution environment's file calls). */
export interface RobotFiles {
  readTextFile(path: string, context: never): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>;
  writeFile(path: string, content: string, context: never): Promise<{ ok: boolean; error?: { message: string } }>;
  createDir(path: string, options: { recursive: boolean }, context: never): Promise<{ ok: boolean; error?: { code: string; message: string } }>;
}

export interface BuildOptions {
  sha256(text: string): Promise<string>;
  sleep?(ms: number): Promise<void>;
  /** How long to wait for the page's report. */
  timeoutMs?: number;
}

interface PageReport { sha?: string; ok?: boolean; errors?: string[]; warnings?: string[]; report?: { pieces: number; joints: number; motors: number; mass_kg: number; settled_height_m: number; tags: string[] } }

/** Write the files robot/ needs where they are missing or differ (the examples too: the agent reads them). Returns the paths it wrote. */
export async function provisionRobotFiles(env: RobotFiles, context: never): Promise<string[]> {
  const wrote: string[] = [];
  for (const dir of ["robot", "robot/examples"]) await env.createDir(dir, { recursive: true }, context);
  for (const [path, content] of Object.entries(ROBOT_TEMPLATES)) {
    const have = await env.readTextFile(`robot/${path}`, context);
    if (have.ok && have.value === content) continue;
    const w = await env.writeFile(`robot/${path}`, content, context);
    if (!w.ok) throw new Error(`robot/${path} could not be written: ${w.error?.message ?? "unknown"}`);
    wrote.push(`robot/${path}`);
  }
  return wrote;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The text the agent gets back, and whether it is an error. */
export async function buildRobot(env: RobotFiles, context: never, o: BuildOptions): Promise<{ text: string; isError: boolean }> {
  let wrote: string[];
  try { wrote = await provisionRobotFiles(env, context); } catch (e) { return { text: `Not built: ${(e as Error).message}.`, isError: true }; }
  const xml = await env.readTextFile("robot/body.xml", context);
  const json = await env.readTextFile("robot/body.json", context);
  if (!xml.ok || !json.ok) {
    const fresh = wrote.length ? ` The helper files are in place (${wrote.join(", ")}).` : "";
    return { text: `No robot is built yet.${fresh} Write robot/body.mjs (it exports robot(name, torso) from ./lib.mjs; robot/examples/dog.mjs and robot/examples/dino.mjs show the format), run \`node robot/build.mjs\`, then call build_robot again.`, isError: false };
  }
  const sha = await o.sha256(xml.value);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? 20_000);
  let report: PageReport | undefined;
  for (;;) {
    const have = await env.readTextFile("robot/build.json", context);
    if (have.ok) {
      try { const r = JSON.parse(have.value) as PageReport; if (r.sha === sha || (r.ok === false && (r.sha === "" || r.sha === undefined))) { report = r; break; } } catch { /* being written */ }
    }
    if (Date.now() > deadline) break;
    await sleep(500);
  }
  if (!report) return { text: "Written, but not checked: the creature page did not report on this body within 20 s. Open the run's page with ?robot=1 so it can compile and show the robot, then call build_robot again.", isError: false };
  const name = (() => { try { return String((JSON.parse(json.value) as { name?: unknown }).name ?? "robot"); } catch { return "robot"; } })();
  if (report.ok === false) return { text: `Not built: ${(report.errors ?? ["the page refused it"]).join("; ")}`, isError: true };
  const r = report.report!;
  const warnings = (report.warnings ?? []).map((w) => ` Warning: ${w}`).join("");
  return { text: `Built ${name}: ${plural(r.pieces, "piece")}, ${plural(r.motors, "motor")}, ${plural(r.joints - r.motors, "spring joint")}, ${r.mass_kg} kg, stands ${r.settled_height_m} m high. Tags: ${r.tags.join(", ")}.${warnings}`, isError: false };
}
