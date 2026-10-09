// The home beat's policy, checked before the take the way the tab will take it. Two sources:
//   a live take (SHOW_PIPE_LINK_FILE): the tab is on the run's own disk and its watcher picks up work/home/policy.json, so there
//     is no static file to check, only the run link, without which the tab never reaches that disk;
//   otherwise the stage serves POLICY_DIR/home.json at /policy/home.json, and the page asks the tab to load it when the run is home.
// The static file goes through the tab's own code (planArrival, then Policy.load), against the body a fresh tab starts with and the
// MuJoCo its build ships, so a passing preflight and a refused policy on camera cannot both happen. The link's secret never reaches
// a message. checkHomePolicy reads the preflight's own environment; checkServedHomePolicy asks a running stage what it serves, so a
// stage started with another POLICY_DIR (or none) cannot pass. Both return [ok, note], the preflight's check shape.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { planArrival } from "../tab/src/arrival.ts";
import { presetForSha } from "../tab/src/bodies.ts";
import { defaultDesign } from "../tab/src/design.ts";
import { buildMjcf } from "../tab/src/mjcf.ts";
import { Policy, PolicyRefused, sha256Hex } from "../tab/src/policy.ts";
import { parseLink } from "./link.ts";
// @ts-expect-error plain .mjs helpers shared with the check scripts
import { assertStage } from "./scripts/cdp.mjs";

export async function checkHomePolicy(env: Record<string, string | undefined>): Promise<[boolean, string]> {
  const linkFile = env.SHOW_PIPE_LINK_FILE;
  if (linkFile) {
    if (!existsSync(linkFile)) return [false, "live take: SHOW_PIPE_LINK_FILE names no file, so the tab never reaches the run's work/home/policy.json"];
    let origin: string;
    try {
      origin = parseLink(readFileSync(linkFile, "utf8")).origin;
    } catch {
      return [false, "live take: SHOW_PIPE_LINK_FILE does not hold a run link (http://host:port/run/<id>#<secret>)"];
    }
    return [true, `live take: home comes from the run's work/home/policy.json, run link set (${origin}); no static file checked`];
  }

  if (!env.POLICY_DIR) {
    return [false, "POLICY_DIR is not set: the stage would serve page/policy/home.json, which a fresh worktree does not have. Set it to the folder with the winner's home.json, here and for serve.ts"];
  }
  const file = join(env.POLICY_DIR, "home.json");
  if (!existsSync(file)) return [false, `no ${file}: the home beat would show "Policy refused: could not fetch /policy/home.json: HTTP 404"`];
  const versions = env.TAB_DIR ? join(env.TAB_DIR, "versions.json") : undefined;
  if (!versions || !existsSync(versions)) return [false, "no versions.json in TAB_DIR: the policy is checked against the MuJoCo the tab's build ships"];
  const mujocoVersion = String(JSON.parse(readFileSync(versions, "utf8")).mujoco);

  const [ok, verdict] = await tabVerdict(readFileSync(file, "utf8"), mujocoVersion);
  return [ok, ok ? `${file}: ${verdict}, ${Math.round(statSync(file).size / 1000)} KB` : verdict];
}

/** The running stage at `origin`: which feed it plays, and the home.json and tab build it serves, through the tab's own code. */
export async function checkServedHomePolicy(origin: string): Promise<[boolean, string]> {
  const base = origin.replace(/\/$/, "");
  try {
    await assertStage(base);
  } catch (error) {
    return [false, (error as Error).message];
  }
  const get = (path: string) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(4000) });
  const info = await get("/api/stage");
  if (!info.ok) return [false, `${base} cannot say what it serves (/api/stage answered ${info.status}): restart it on this code`];
  const { feed, tab } = (await info.json()) as { feed: string; tab: string };
  if (feed === "pipe") return [true, `live take (a pipe feed): the stage's tab reads the run's own work/home/policy.json; no static file checked`];
  if (tab !== "app") return [false, `the stage serves the stub tab, which cannot load a policy: start serve.ts with TAB_DIR set to the tab app's dist`];
  const versions = await get("/tab/versions.json");
  if (!versions.ok) return [false, `the stage's tab has no versions.json (HTTP ${versions.status}): rebuild the tab app`];
  const mujocoVersion = String(((await versions.json()) as { mujoco: unknown }).mujoco);
  const home = await get("/policy/home.json");
  if (!home.ok) return [false, `the stage's home beat would show "Policy refused: could not fetch /policy/home.json: HTTP ${home.status}": restart it with POLICY_DIR set to the folder with the winner's home.json`];
  const text = await home.text();
  const [ok, verdict] = await tabVerdict(text, mujocoVersion);
  return [ok, ok ? `served by the stage: ${verdict}, ${Math.round(text.length / 1000)} KB (${feed} feed)` : verdict];
}

/** What the tab does with a home policy when the run is home: planArrival on a fresh tab's body, then Policy.load. */
async function tabVerdict(text: string, mujocoVersion: string): Promise<[boolean, string]> {
  const start = defaultDesign();
  const plan = await planArrival(text, await sha256Hex(buildMjcf(start).xml), presetForSha);
  if (plan.action === "refuse") return [false, `the tab would refuse it: ${plan.reason}`];
  const built = buildMjcf(plan.action === "switch-body" ? plan.preset.design : start);
  try {
    await Policy.load(text, { mjcfSha256: await sha256Hex(built.xml), nj: built.jointNames.length, mujocoVersion });
  } catch (error) {
    return [false, `the tab would refuse it: ${error instanceof PolicyRefused ? error.message : String(error)}`];
  }
  const body = plan.action === "switch-body" ? `switches to the "${plan.preset.name}" body` : "the body a fresh tab starts with";
  return [true, `the tab loads it, ${body}, MuJoCo ${mujocoVersion}`];
}
