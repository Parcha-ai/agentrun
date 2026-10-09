// What goes home to the tab must be a policy the tab will run (../policy/POLICY-FORMAT.md, ../policy/policy.ts). The
// combined walk + getup file (D2's export.py combine, made by the winner's machine) goes home only when:
//   1. it is strict JSON with no NaN or Infinity anywhere, the base64 float32 weights of every layer included (Python's
//      json writes NaN unless told not to, and a diverged network carries NaN weights);
//   2. its walking network walks: the winner's walk file reports walk_10s.distance_m of at least MIN_WALK_M;
//   3. it was built from the current walk and getup files: its provenance.walk.steps and provenance.getup.steps are
//      those files' own provenance.steps (a stale snapshot has other steps), and it is newer than both when the reader
//      knows file times;
//   4. the tab's own loader (Policy.load) accepts it for the run's body.
// Otherwise the winner's walk file goes home alone if it passes 1, 2 and 4, and the stage is told why; if it fails too,
// nothing goes home.
import { createHash } from "node:crypto";
import { Policy } from "../policy/policy.ts";

/** A walk this short in 10 s is a policy that does not walk (a diverged network scored 0.003 m). */
export const MIN_WALK_M = 0.5;

export type PolicyFileRead = { readonly text: string; readonly mtimeMs?: number };
export type HomeChoice = { readonly path: string | null; readonly getup: boolean; readonly reason?: string };

type Layer = { w?: unknown; b?: unknown };
type Net = { layers?: Layer[]; obs?: { mean?: unknown; std?: unknown } };
type PolicyJson = Net & { mjcf_sha256?: unknown; getup?: Net; provenance?: { steps?: unknown; walk?: { steps?: unknown }; getup?: { steps?: unknown }; walk_10s?: { distance_m?: unknown } } };

const finite = (xs: unknown): boolean => !Array.isArray(xs) || xs.every((x) => typeof x !== "number" || Number.isFinite(x));

/** A base64 run of little-endian float32s, every one finite. */
function finiteWeights(b64: unknown): boolean {
  if (typeof b64 !== "string") return true;
  const bytes = Buffer.from(b64, "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.byteLength; i += 4) if (!Number.isFinite(view.getFloat32(i, true))) return false;
  return true;
}

/** 1: strict JSON, and no NaN or Infinity in any network's normalisation or weights. */
export function strictPolicy(text: string): { ok: true; policy: PolicyJson } | { ok: false; reason: string } {
  let policy: PolicyJson;
  try {
    // JSON.parse takes no NaN, Infinity or -Infinity: a file holding one is refused here as the tab refuses it.
    policy = JSON.parse(text) as PolicyJson;
  } catch (error) {
    return { ok: false, reason: `not strict JSON (${(error as Error).message.slice(0, 80)})` };
  }
  if (typeof policy !== "object" || policy === null) return { ok: false, reason: "not a policy object" };
  for (const [name, net] of [["walk", policy], ["getup", policy.getup]] as const) {
    if (!net) continue;
    if (!finite(net.obs?.mean) || !finite(net.obs?.std)) return { ok: false, reason: `the ${name} network's normalisation is not finite` };
    for (const [i, layer] of (net.layers ?? []).entries()) {
      if (!finiteWeights(layer.w) || !finiteWeights(layer.b)) return { ok: false, reason: `the ${name} network's layer ${i} has NaN or infinite weights` };
    }
  }
  return { ok: true, policy };
}

/** 4: the tab's loader, for the run's body. Null when it accepts the file. */
async function tabRefuses(text: string, body: { mjcfSha256: string; nj: number }): Promise<string | null> {
  try {
    await Policy.load(text, body);
    return null;
  } catch (error) {
    return `the tab refuses it (${(error as Error).message.slice(0, 100)})`;
  }
}

/** The walk file goes home on its own merits: 1, 2 and 4. Null when it may. */
async function walkRefused(walk: PolicyFileRead, body: { mjcfSha256: string; nj: number }): Promise<string | null> {
  const strict = strictPolicy(walk.text);
  if (!strict.ok) return strict.reason;
  const metres = strict.policy.provenance?.walk_10s?.distance_m;
  if (typeof metres !== "number" || !(metres >= MIN_WALK_M)) return `its walk test covered ${typeof metres === "number" ? metres.toFixed(3) : "no"} m in 10 s`;
  return tabRefuses(walk.text, body);
}

export interface HomeSources {
  /** A file of the winner's run under work/, or null when it is not there. */
  read(path: string): Promise<PolicyFileRead | null>;
  /** The winner's universe: its walk file is train/<universe>/policy.json. */
  readonly universe: string;
  /** The run's creature.xml: mjcf_sha256 is its SHA-256. */
  readonly creatureXml: string;
  /** The body's joint count, as the tab checks it. */
  readonly nj: number;
}

/** Which file of the winner's run goes home: the combined one, the walk file alone, or none, and why. */
export async function chooseHomePolicy(s: HomeSources): Promise<HomeChoice> {
  const body = { mjcfSha256: createHash("sha256").update(s.creatureXml).digest("hex"), nj: s.nj };
  const walkPath = `train/${s.universe}/policy.json`;
  const walk = await s.read(walkPath);
  if (!walk) return { path: null, getup: false, reason: `the winner has no ${walkPath}` };
  const walkBad = await walkRefused(walk, body);
  const getup = (await s.read("train/getup/policy.json")) ?? (await s.read("getup/policy.json"));
  const combined = await s.read("home/policy.json");
  let why: string;
  if (walkBad) why = `the walk policy is refused: ${walkBad}`;
  else if (!combined) why = "no combined policy was made";
  else if (!getup) why = "the getup policy it was built from is not in the run";
  else {
    const strict = strictPolicy(combined.text);
    const walkSteps = (JSON.parse(walk.text) as PolicyJson).provenance?.steps;
    const getupSteps = (JSON.parse(getup.text) as PolicyJson).provenance?.steps;
    if (!strict.ok) why = strict.reason;
    else if (!strict.policy.getup) why = "it has no getup network";
    else if (strict.policy.provenance?.walk?.steps !== walkSteps) why = `it was built from another walk policy (${String(strict.policy.provenance?.walk?.steps)} steps, the winner's has ${String(walkSteps)})`;
    else if (strict.policy.provenance?.getup?.steps !== getupSteps) why = `it was built from another getup policy (${String(strict.policy.provenance?.getup?.steps)} steps, the run's has ${String(getupSteps)})`;
    else if (combined.mtimeMs !== undefined && ((walk.mtimeMs ?? 0) > combined.mtimeMs || (getup.mtimeMs ?? 0) > combined.mtimeMs)) why = "it is older than the files it was built from";
    else {
      const refused = await tabRefuses(combined.text, body);
      if (!refused) return { path: "home/policy.json", getup: true };
      why = refused;
    }
  }
  if (walkBad) return { path: null, getup: false, reason: why };
  return { path: walkPath, getup: false, reason: `getup not attached: ${why}` };
}
