// The home beat's policy, checked before the take the way the tab will take it. Two sources:
//   a live take (SHOW_PIPE_LINK_FILE): the tab is on the run's own disk and its watcher picks up work/home/policy.json, so there
//     is no static file to check, only the run link, without which the tab never reaches that disk;
//   otherwise the stage serves POLICY_DIR/home.json at /policy/home.json, and the page asks the tab to load it when the run is home.
// The static file goes through the tab's own code (planArrival, then Policy.load), against the body a fresh tab starts with and the
// MuJoCo its build ships, so a passing preflight and a refused policy on camera cannot both happen. The link's secret never reaches
// a message. Returns [ok, note], the preflight's check shape.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { planArrival } from "../tab/src/arrival.ts";
import { presetForSha } from "../tab/src/bodies.ts";
import { defaultDesign } from "../tab/src/design.ts";
import { buildMjcf } from "../tab/src/mjcf.ts";
import { Policy, PolicyRefused, sha256Hex } from "../tab/src/policy.ts";
import { parseLink } from "./link.ts";

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

  const text = readFileSync(file, "utf8");
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
  return [true, `${file}: the tab loads it, ${body}, MuJoCo ${mujocoVersion}, ${Math.round(statSync(file).size / 1000)} KB`];
}
